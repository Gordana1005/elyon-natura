-- ============================================================================
-- The 7-day no-parcel rule (Phase 4 of the money plan, owner ruling 2026-09-27)
-- ============================================================================
-- RULE (Mile): AlterCPA decides only confirmed-or-dead; MEX decides money. An
-- AlterCPA-confirmed order (incl. the 11.08 cancel-other → confirmed mirror)
-- that still has NO MEX parcel 7 days after the sale is cancelled with reason
-- `no_parcel_7d`. A parcel that appears later reopens it (mex-reconcile rule C:
-- a COD-matching parcel on an AlterCPA-cancelled order → shipped).
--
-- ROLLOUT: mode 'report' first — the nightly run only writes its ledger, it
-- never touches `orders`. One week of reports, then Mile flips
-- app_settings.no_parcel_rule.mode to 'apply'. On 2026-09-28 the rule matched
-- 569 orders (€15.777), 515 of them sold in August; 47 had an unlinked parcel
-- on the same phone (→ needs linking, never cancelled).
--
-- WHO IS IN SCOPE — byte-for-byte the Overview rail's `anp` CTE
-- (20260936000000_insights_overview.sql) and overview.ts attentionFilter, so the
-- rail, GET /orders?attention=approved_no_parcel_7d and this rule list the same
-- orders — plus three safety exclusions of its own:
--   status confirmed · sale_source altercpa|affiliate (settings.sources) ·
--   coalesce(sold_at, confirmed_at, created_at) older than `days` · no
--   mex_tracking_id · ship_after_date not in the future
--   AND sold on/after settings.from_date (2026-08-01: earlier AlterCPA sales are
--       the 11.08 operator ruling, report only — never this rule)
--   AND not packed in the last 2 days (the warehouse is holding it)
--   AND no UNLINKED parcel on the same phone created from 2 days before the sale
--       → those go to `needs_linking` instead: the parcel probably IS this sale.
--
-- DESIGN NOTES
--   * Hourly at :10, self-gated to settings.hour (21 → 21:10 Skopje, after the
--     07:00–20:55 crons), one scheduled run per Skopje day (partial unique
--     index) — DST-proof and self-healing like notify_unpaid_shipped_orders.
--   * No trigger writes order_history, so apply mode writes it (and a note)
--     itself, as the 27.09 repairs did. Actor: 'System (no-parcel-7d)'.
--   * elyon.bulk_repair is set LOCAL in apply mode: no confirm-rate alert storm
--     from a night of cancels.
--   * The ledger (runs + items) is owner-only (is_business_owner): it carries
--     prices. Written only by this SECURITY DEFINER function.
-- ============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- ── 1. Settings ────────────────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value) VALUES
  ('no_parcel_rule', jsonb_build_object(
      'mode',      'report',                       -- report | apply
      'days',      7,
      'sources',   jsonb_build_array('altercpa', 'affiliate'),
      'from_date', '2026-08-01',
      'hour',      21))
ON CONFLICT (key) DO NOTHING;

-- ── 2. Ledger ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.no_parcel_rule_runs (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_day             date        NOT NULL,             -- Europe/Skopje
  ran_at              timestamptz NOT NULL DEFAULT now(),
  mode                text        NOT NULL CHECK (mode IN ('report', 'apply')),
  trigger_kind        text        NOT NULL CHECK (trigger_kind IN ('cron', 'manual')),
  days                integer     NOT NULL,
  candidates          integer     NOT NULL DEFAULT 0,
  to_cancel           integer     NOT NULL DEFAULT 0,
  needs_linking       integer     NOT NULL DEFAULT 0,
  cancelled           integer     NOT NULL DEFAULT 0,
  value_eur           numeric(12,2) NOT NULL DEFAULT 0,  -- to_cancel's value
  cancelled_value_eur numeric(12,2) NOT NULL DEFAULT 0,
  settings            jsonb       NOT NULL DEFAULT '{}'::jsonb
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_no_parcel_rule_runs_cron_day
  ON public.no_parcel_rule_runs (run_day) WHERE trigger_kind = 'cron';

CREATE TABLE IF NOT EXISTS public.no_parcel_rule_items (
  run_id             uuid        NOT NULL REFERENCES public.no_parcel_rule_runs(id) ON DELETE CASCADE,
  order_id           uuid        NOT NULL REFERENCES public.orders(id) ON DELETE CASCADE,
  display_id         text,
  action             text        NOT NULL CHECK (action IN ('cancel', 'needs_linking', 'cancelled', 'skipped')),
  sold_at            timestamptz,
  days_waiting       integer,
  price_eur          numeric(12,2),
  sold_by_person_id  uuid,
  parcel_tracking    text,       -- needs_linking: the unlinked parcel on the same phone
  other_order_id     uuid,       -- cancel: the same phone's parcel belongs to this order
  PRIMARY KEY (run_id, order_id)
);
CREATE INDEX IF NOT EXISTS idx_no_parcel_rule_items_order ON public.no_parcel_rule_items (order_id);

COMMENT ON TABLE public.no_parcel_rule_runs IS
  '2026-09-28: one row per run of apply_no_parcel_rule() (7-day no-parcel rule). report mode writes only this ledger; apply mode also cancels (reason no_parcel_7d). Owner-only.';
COMMENT ON TABLE public.no_parcel_rule_items IS
  '2026-09-28: the orders each no-parcel run matched: cancel (report) | cancelled (apply) | needs_linking (an unlinked MEX parcel on the same phone — never cancelled) | skipped (changed under the run). Owner-only.';

ALTER TABLE public.no_parcel_rule_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.no_parcel_rule_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.no_parcel_rule_runs, public.no_parcel_rule_items FROM PUBLIC;
REVOKE ALL ON public.no_parcel_rule_runs, public.no_parcel_rule_items FROM anon, authenticated;
GRANT SELECT ON public.no_parcel_rule_runs, public.no_parcel_rule_items TO authenticated;
GRANT ALL ON public.no_parcel_rule_runs, public.no_parcel_rule_items TO service_role;

DROP POLICY IF EXISTS no_parcel_rule_runs_owners ON public.no_parcel_rule_runs;
CREATE POLICY no_parcel_rule_runs_owners ON public.no_parcel_rule_runs
  FOR SELECT TO authenticated USING (public.is_business_owner(auth.uid()));
DROP POLICY IF EXISTS no_parcel_rule_items_owners ON public.no_parcel_rule_items;
CREATE POLICY no_parcel_rule_items_owners ON public.no_parcel_rule_items
  FOR SELECT TO authenticated USING (public.is_business_owner(auth.uid()));

-- ── 3. The rule ────────────────────────────────────────────────────────────
-- _force   = skip the hour gate and the once-a-day guard (manual run)
-- _dry_run = compute and return the summary, write NOTHING
CREATE OR REPLACE FUNCTION public.apply_no_parcel_rule(
  _force   boolean DEFAULT false,
  _dry_run boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg        jsonb;
  _mode       text;
  _days       integer;
  _sources    text[];
  _from_date  date;
  _hour       integer;
  _skopje_now timestamp := now() AT TIME ZONE 'Europe/Skopje';
  _today      date;
  _run        uuid;
  _cand       integer;
  _cancel     integer;
  _link       integer;
  _value      numeric;
  _done       integer := 0;
  _done_value numeric := 0;
  _actor      constant text := 'System (no-parcel-7d)';
BEGIN
  _today := _skopje_now::date;

  SELECT value INTO _cfg FROM public.app_settings WHERE key = 'no_parcel_rule';
  _cfg       := coalesce(_cfg, '{}'::jsonb);
  _mode      := coalesce(_cfg->>'mode', 'report');
  _days      := greatest(coalesce((_cfg->>'days')::int, 7), 3);   -- never below 3 days
  _sources   := coalesce(ARRAY(SELECT jsonb_array_elements_text(_cfg->'sources')), ARRAY['altercpa', 'affiliate']);
  _from_date := coalesce((_cfg->>'from_date')::date, DATE '2026-08-01');
  _hour      := coalesce((_cfg->>'hour')::int, 21);
  IF _mode NOT IN ('report', 'apply') THEN _mode := 'report'; END IF;

  IF NOT _force AND NOT _dry_run THEN
    IF extract(hour FROM _skopje_now)::int <> _hour THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'outside the ' || _hour || ':00 Skopje window');
    END IF;
    IF EXISTS (SELECT 1 FROM public.no_parcel_rule_runs r WHERE r.run_day = _today AND r.trigger_kind = 'cron') THEN
      RETURN jsonb_build_object('ok', true, 'skipped', 'already ran today');
    END IF;
  END IF;

  CREATE TEMP TABLE _np ON COMMIT DROP AS
  WITH anp AS (
    SELECT x.id, x.display_id, coalesce(x.price, 0) AS price, x.sold_by_person_id,
           coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at,
           right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) AS p8
    FROM public.orders x
    WHERE x.status = 'confirmed'
      AND x.sale_source = ANY (_sources)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < now() - make_interval(days => _days)
      AND coalesce(x.sold_at, x.confirmed_at, x.created_at) >= (_from_date::timestamp AT TIME ZONE 'Europe/Skopje')
      AND x.mex_tracking_id IS NULL
      AND (x.ship_after_date IS NULL OR x.ship_after_date <= _today)
      AND (x.packed_at IS NULL OR x.packed_at < now() - interval '2 days')
  )
  SELECT a.*,
         (_today - (a.sold_at AT TIME ZONE 'Europe/Skopje')::date) AS days_waiting,
         (SELECT p.tracking_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NULL
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS unlinked_tracking,
         (SELECT p.order_id FROM public.mex_parcels p
           WHERE length(a.p8) = 8 AND p.phone8 = a.p8 AND p.order_id IS NOT NULL AND p.order_id <> a.id
             AND p.created_at_mex >= a.sold_at - interval '2 days'
           ORDER BY p.created_at_mex LIMIT 1) AS other_order_id
  FROM anp a;

  SELECT count(*),
         count(*) FILTER (WHERE unlinked_tracking IS NULL),
         count(*) FILTER (WHERE unlinked_tracking IS NOT NULL),
         coalesce(sum(price) FILTER (WHERE unlinked_tracking IS NULL), 0)
    INTO _cand, _cancel, _link, _value
  FROM _np;

  IF _dry_run THEN
    RETURN jsonb_build_object('ok', true, 'dry_run', true, 'mode', _mode, 'days', _days,
                              'candidates', _cand, 'to_cancel', _cancel, 'needs_linking', _link,
                              'value_eur', round(_value, 2));
  END IF;

  INSERT INTO public.no_parcel_rule_runs (run_day, mode, trigger_kind, days, candidates, to_cancel,
                                          needs_linking, value_eur, settings)
  VALUES (_today, _mode, CASE WHEN _force THEN 'manual' ELSE 'cron' END, _days, _cand, _cancel,
          _link, round(_value, 2), _cfg)
  RETURNING id INTO _run;

  INSERT INTO public.no_parcel_rule_items (run_id, order_id, display_id, action, sold_at, days_waiting,
                                           price_eur, sold_by_person_id, parcel_tracking, other_order_id)
  SELECT _run, n.id, n.display_id,
         CASE WHEN n.unlinked_tracking IS NOT NULL THEN 'needs_linking' ELSE 'cancel' END,
         n.sold_at, n.days_waiting, n.price, n.sold_by_person_id, n.unlinked_tracking, n.other_order_id
  FROM _np n;

  IF _mode = 'apply' AND _cancel > 0 THEN
    PERFORM set_config('elyon.bulk_repair', 'on', true);

    -- Status-guarded: an order that moved (or got a parcel) since the scan is left alone.
    WITH upd AS (
      UPDATE public.orders o
         SET status = 'cancelled',
             cancellation_reason = 'no_parcel_7d',
             cancellation_reason_notes = 'No MEX parcel ' || n.days_waiting || ' days after the AlterCPA approval (7-day rule).'
        FROM _np n
       WHERE n.unlinked_tracking IS NULL
         AND o.id = n.id
         AND o.status = 'confirmed'
         AND o.mex_tracking_id IS NULL
      RETURNING o.id, n.price, n.sold_at, n.days_waiting
    ), hist AS (
      INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
      SELECT u.id, 'confirmed'::public.order_status, 'cancelled'::public.order_status, NULL, _actor FROM upd u
      RETURNING order_id
    ), notes AS (
      INSERT INTO public.order_notes (order_id, text, author_id, author_name)
      SELECT u.id,
             'Cancelled automatically: approved in AlterCPA on '
               || to_char(u.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY')
               || ', no MEX parcel after ' || u.days_waiting
               || ' days. A parcel that appears later reopens the order.',
             NULL, _actor
      FROM upd u
      RETURNING order_id
    ), marked AS (
      UPDATE public.no_parcel_rule_items i SET action = 'cancelled'
        FROM upd u WHERE i.run_id = _run AND i.order_id = u.id
      RETURNING i.order_id
    )
    SELECT count(*), coalesce(sum(u.price), 0) INTO _done, _done_value
    FROM upd u;

    UPDATE public.no_parcel_rule_items SET action = 'skipped'
     WHERE run_id = _run AND action = 'cancel';

    UPDATE public.no_parcel_rule_runs
       SET cancelled = _done, cancelled_value_eur = round(_done_value, 2)
     WHERE id = _run;
    -- No audit_log row: it requires a human actor_id. The run + items ledger
    -- above IS the audit trail (who, what, when, value).
  END IF;

  RETURN jsonb_build_object('ok', true, 'run_id', _run, 'mode', _mode, 'days', _days,
                            'candidates', _cand, 'to_cancel', _cancel, 'needs_linking', _link,
                            'value_eur', round(_value, 2), 'cancelled', _done);
END;
$fn$;

COMMENT ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) IS
  '2026-09-28: the 7-day no-parcel rule. AlterCPA-confirmed orders with no MEX parcel N days after the sale: report mode → ledger only; apply mode → cancelled (no_parcel_7d) + order_history + note. Same-phone unlinked parcel → needs_linking, never cancelled. (_force) manual run, (_dry_run) writes nothing.';

REVOKE ALL ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) TO service_role;

COMMIT;

-- ── 4. Schedule — hourly at :10, self-gated to settings.hour Skopje ────────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'no-parcel-rule') THEN
    PERFORM cron.unschedule('no-parcel-rule');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'no-parcel-rule',
  '10 * * * *',
  $job$SELECT public.apply_no_parcel_rule();$job$
);
