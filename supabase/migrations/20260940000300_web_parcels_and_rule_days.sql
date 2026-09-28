-- ============================================================================
-- WEB PARCELS BY PHONE · THE NO-PARCEL RULE'S DAYS · TEST PHONES IN THE OLDER
-- OVERVIEW BLOCKS (2026-09-28)
--
-- Three owner items, one migration (read-side + web_orders links only; no
-- orders row, no mex_parcels row and nothing on the shop is written here):
--
-- ── A. Web orders ↔ their NATURA "M…" parcels (web_phone_link_candidates,
--       web_link_mex_parcels_by_phone) ──────────────────────────────────────
-- Found 28.09: web_link_mex_parcels links a web order to its parcel only by
-- the shop's waybill, an NTMK sender_reference or an NTMK tracking id. The
-- OpenCart-era shop (the OC-… web orders, 2022 → 18.08.2026) shipped through
-- the NATURA account under bare "M<digits>" waybills (no DocNumber series)
-- that the shop never recorded — so none of its ~3.175 parcels was linked,
-- and every one of those sales was counted TWICE: once as the web order
-- (paid_legacy, the shop's own outcome) and once as a MEX-only parcel
-- (teleshop_other / mex_other). Read-only investigation 28.09 (NATURA "M…",
-- 30.03 → 25.09.2026; 2.611 carry COD, 564 COD 0):
--   * a COD parcel's COD equals a web order's total to the denar on the same
--     phone (2.468 of the 2.611), created 0–5 days after the order (native
--     NTMK orders ship 0–119 h after too); the M series with COD stops 04.09 —
--     the day the new shop (NTMK…) started;
--   * a COD-0 parcel matches a web order the shop marks PAID (322 of the 324
--     COD-0 parcels on a web customer's phone: DELIVERED/COD/PAID, prepaid) —
--     money the shop collected, so MEX had nothing to collect;
--   * the rest of the COD-0 set is B2B: 198 parcels to the company's own
--     stores ("СТОРС-ПРОДАВНИЦА …") and dm drugstore branches — no web order
--     on those phones, and nothing here links them;
--   * no M… parcel falls in the window of a web order that already holds a
--     parcel (0 duplicates of an NTMK link).
-- THE MATCHER (safe by construction; a link needs ALL of):
--   parcel   NATURA account · tracking 'M' + digits · no series · held by no
--            CRM order (mex_parcels.order_id, orders.mex_tracking_id) and
--            claimed by no web order (live or deleted) · an 8-digit phone8
--   order    live web order · no link yet · no waybill of its own (an order
--            with a waybill waits for its own parcel: tracking > sender_ref >
--            order_number) · total > 0 · not a failed card checkout
--   phone    the same last 8 digits
--   time     parcel created from 1 h before to 10 days after the order
--   amount   COD = round(total) ±1 · or COD = round(total + shipping) ±1 · or
--            COD 0 with the shop's payment PAID / PARTIALLY_REFUNDED (card, or
--            recorded prepaid)
--   unique   EXACTLY ONE candidate on both sides — pass 1 within 5 days; pass
--            2 within 10 days over what pass 1 left (a 5–10 day pair only when
--            neither side has any other candidate in 10 days). Two same-amount
--            orders minutes apart with two parcels are left alone (ambiguous).
-- A phone link (mex_link_method 'phone_amount') is the weakest evidence and
-- YIELDS: it is released when another live web order claims the parcel by a
-- deterministic method, when a CRM order holds the parcel, or when the order
-- gets a waybill of its own. Idempotent: a re-run links nothing new.
-- Dry run 28.09 (all time): 2.751 links = 2.422 COD = total + 322 prepaid
-- COD 0 (pass 1) + 7 (pass 2); of the 324 COD-0 parcels on a web customer's
-- phone 322 link (664.032 ден), 2 are one customer's two same-second parcels
-- for two orders (ambiguous). Web-sync calls the writer after
-- web_link_mex_parcels (incremental: orders of the last 60 days; sweep: all).
--
-- COUNTED ONCE: a claim is web_orders.mex_tracking_id, the one thing every
-- report reads (insights_sale_rows `wc`/`wo`/`mo`, insights_cash_rows `wcl`,
-- insights_leads_rows, insights_overview v_claimed, insights_web_block
-- `linked`, customer_timeline, collabbox_feed_state). A linked parcel leaves
-- MEX-only and the web order is judged by its parcel: for 01.03–31.08.2026 the
-- cohort total drops from 61.737 · 134.679.812 ден to 59.309 · 130.519.139
-- (the 2.428 double counts), Σ COD unchanged (117.031.044). 01–27.09 sales:
-- unchanged (7.173 · 17.959.541 — the OC history ends 18.08); cash: 7 parcels
-- (6.203 ден) move from MEX-only to web.
--
-- ── B. The no-parcel rule's days follow app_settings (owner: 7 → 10) ───────
-- public.no_parcel_rule_days() = app_settings.no_parcel_rule.days, default 10,
-- never below 3 — THE reader for apply_no_parcel_rule(), integrations_health()
-- (days_n), insights_overview()'s `anp` (attention approved_no_parcel_7d, now
-- carrying `days`) and GET /orders?attention=approved_no_parcel_7d (overview.ts
-- attentionFilter, via the api). The stored codes stay: cancellation_reason
-- 'no_parcel_7d', attention kind 'approved_no_parcel_7d', actor
-- 'System (no-parcel-7d)'.
--
-- ── C. The owner's test phones leave the older Overview blocks ─────────────
-- public.report_excluded_phones (20260939000700), the foundation's way
-- (20260940000000): read once per call, handed to the query as a constant;
-- an order on such a phone (last 8 digits) or holding such a parcel, a web
-- order on such a phone or linked to such a parcel, and such a parcel, are in
-- no figure of insights_overview (kpis, sources, trend, teams, attention,
-- waiting web orders), insights_web_block and insights_pivot.
--
-- REPLACES (each copied from its LIVE definition, pg_get_functiondef
-- 28.09.2026, and changed only where noted — equal to its migration file):
--   apply_no_parcel_rule(boolean, boolean)      20260938000000  days + note text
--   integrations_health()                        20260939000200  days_n
--   insights_overview(text, text, text, text)    20260936000000  test phones + anp days
--   insights_web_block(text, text)               20260937000000  test phones
--   insights_pivot(text, text, text[])           20260936000000  test phones
-- ADDS: no_parcel_rule_days(), web_phone_link_candidates(integer[], integer),
-- web_link_mex_parcels_by_phone(integer[], integer, boolean); widens
-- web_orders_mex_link_method_check by 'phone_amount'.
--
-- Deploy order: this migration, then `web-sync` and `api` (both degrade
-- gracefully before it: web-sync records the missing function as a warning,
-- the api's attention filter falls back to 10 days).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.insights_excluded8(text,text[])') IS NULL
     OR to_regprocedure('public.insights_phone8(text)') IS NULL THEN
    RAISE EXCEPTION 'apply 20260939000700 and 20260940000000 first (the test-phone list and its helpers)';
  END IF;
  IF to_regclass('public.web_orders') IS NULL OR to_regclass('public.app_settings') IS NULL THEN
    RAISE EXCEPTION 'public.web_orders / public.app_settings missing — apply 20260937000000 and 20260938000000 first';
  END IF;
END
$dep$;

-- ── 1. The no-parcel rule's days: ONE reader ────────────────────────────────
CREATE OR REPLACE FUNCTION public.no_parcel_rule_days()
RETURNS integer
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT greatest(coalesce(
           (SELECT CASE WHEN btrim(s.value ->> 'days') ~ '^[0-9]{1,4}$'
                        THEN btrim(s.value ->> 'days')::integer END
              FROM public.app_settings s
             WHERE s.key = 'no_parcel_rule'),
           10), 3)
$fn$;

COMMENT ON FUNCTION public.no_parcel_rule_days() IS
  'The no-parcel rule''s days: app_settings.no_parcel_rule.days, default 10, never below 3 (owner 28.09: 7 → 10). THE reader for apply_no_parcel_rule(), integrations_health(), insights_overview() (attention approved_no_parcel_7d) and GET /orders?attention=approved_no_parcel_7d. Migration 20260940000300.';

REVOKE ALL ON FUNCTION public.no_parcel_rule_days() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.no_parcel_rule_days() TO service_role;

-- ── 2. A fourth link method: phone_amount ──────────────────────────────────
ALTER TABLE public.web_orders DROP CONSTRAINT IF EXISTS web_orders_mex_link_method_check;
ALTER TABLE public.web_orders ADD CONSTRAINT web_orders_mex_link_method_check
  CHECK (mex_link_method IN ('tracking', 'sender_reference', 'order_number', 'phone_amount'));

COMMENT ON COLUMN public.web_orders.mex_link_method IS
  'How mex_tracking_id was decided: tracking (the shop''s waybill) · sender_reference / order_number (our number as MEX stored it) — web_link_mex_parcels; phone_amount (an OpenCart-era NATURA "M…" waybill: same phone, 1 h before → 10 days after the order, COD = total or 0 when prepaid, the only candidate on both sides) — web_link_mex_parcels_by_phone, which releases it again when stronger evidence appears. Migration 20260940000300.';
COMMENT ON COLUMN public.web_orders.mex_tracking_id IS
  'MEX parcel this order shipped under (a claim: every report counts the parcel as this web order''s). tracking / sender_reference / order_number: web_link_mex_parcels; phone_amount: web_link_mex_parcels_by_phone. Read from mex_parcels, never written into it.';

-- ── 3. The phone matcher: candidates (read-only) ───────────────────────────
-- Every (web order, parcel) pair the matcher would link NOW. Uniqueness is
-- judged over ALL candidates; p_ids / p_recent_days (web orders created in
-- the last N days) only narrow what is returned. Pure SQL, no temp table: the
-- read-only harness and scripts/backfill-web-parcel-links.mjs call it with
-- read_only: true.
CREATE OR REPLACE FUNCTION public.web_phone_link_candidates(
  p_ids         integer[] DEFAULT NULL,
  p_recent_days integer   DEFAULT NULL)
RETURNS TABLE (
  shop_order_id     integer,
  order_number      text,
  tracking_id       text,
  pass              integer,
  rule              text,
  hours_after       numeric,
  web_created_at    timestamptz,
  parcel_created_at timestamptz,
  web_status        text,
  payment_method    text,
  payment_status    text,
  web_total         numeric,
  cod_mkd           integer,
  parcel_status_id  integer,
  phone8            text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
WITH
-- web orders that may take a parcel by phone: live, unlinked, no waybill of
-- their own, something to collect
np_wo AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.phone8, w.created_at, w.total, w.shipping_total,
         w.payment_method, w.payment_status, w.status
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL
    AND w.mex_tracking_id IS NULL
    AND w.tracking_number IS NULL
    AND w.phone8 ~ '^[0-9]{8}$'
    AND w.total > 0
),
-- the OpenCart-era shop waybills nobody holds: NATURA, 'M' + digits, no series,
-- no CRM order (either link direction), no web claim (live or deleted)
np_mp AS MATERIALIZED (
  SELECT p.tracking_id, p.phone8, p.created_at_mex, p.cod_mkd, p.status_id
  FROM public.mex_parcels p
  WHERE p.account = 'natura'
    AND p.tracking_id ~ '^M[0-9]+$'
    AND p.series IS NULL
    AND p.order_id IS NULL
    AND p.phone8 ~ '^[0-9]{8}$'
    AND p.created_at_mex IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = p.tracking_id)
    AND NOT EXISTS (SELECT 1 FROM public.web_orders w2 WHERE w2.mex_tracking_id = p.tracking_id)
),
-- every pair the evidence allows: same phone, 1 h before → 10 days after, and
-- the amount rule
np_ok AS MATERIALIZED (
  SELECT r.* FROM (
    SELECT wo.shop_order_id, wo.order_number, wo.phone8, wo.created_at, wo.total, wo.shipping_total,
           wo.payment_method, wo.payment_status, wo.status,
           mp.tracking_id, mp.cod_mkd, mp.status_id, mp.created_at_mex,
           CASE WHEN coalesce(mp.cod_mkd, 0) > 0 AND abs(mp.cod_mkd - round(wo.total)) <= 1
                  THEN 'cod_total'
                WHEN coalesce(mp.cod_mkd, 0) > 0 AND wo.shipping_total > 0
                     AND abs(mp.cod_mkd - round(wo.total + wo.shipping_total)) <= 1
                  THEN 'cod_total_shipping'
                WHEN coalesce(mp.cod_mkd, 0) = 0 AND wo.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
                  THEN 'prepaid_cod0'
           END AS rule
    FROM np_wo wo
    JOIN np_mp mp ON mp.phone8 = wo.phone8
                 AND mp.created_at_mex >= wo.created_at - interval '1 hour'
                 AND mp.created_at_mex <  wo.created_at + interval '10 days'
  ) r
  WHERE r.rule IS NOT NULL
    -- a failed card checkout never ships (the shop's own classifier, once per pair)
    AND public.web_order_outcome(r.status, r.payment_status, r.payment_method) <> 'card_unpaid'
),
-- pass 1: within 5 days, exactly one candidate on each side
np_p1 AS MATERIALIZED (
  SELECT z.* FROM (
    SELECT k.*, count(*) OVER (PARTITION BY k.shop_order_id) AS n_w,
                count(*) OVER (PARTITION BY k.tracking_id)   AS n_p
    FROM np_ok k
    WHERE k.created_at_mex < k.created_at + interval '5 days'
  ) z
  WHERE z.n_w = 1 AND z.n_p = 1
),
-- pass 2: within 10 days, over what pass 1 left, exactly one on each side
np_p2 AS MATERIALIZED (
  SELECT z.* FROM (
    SELECT k.*, count(*) OVER (PARTITION BY k.shop_order_id) AS n_w,
                count(*) OVER (PARTITION BY k.tracking_id)   AS n_p
    FROM np_ok k
    WHERE NOT EXISTS (SELECT 1 FROM np_p1 a WHERE a.shop_order_id = k.shop_order_id)
      AND NOT EXISTS (SELECT 1 FROM np_p1 a WHERE a.tracking_id = k.tracking_id)
  ) z
  WHERE z.n_w = 1 AND z.n_p = 1
),
np_cand AS (
  SELECT 1 AS pass, a.* FROM np_p1 a
  UNION ALL
  SELECT 2, b.* FROM np_p2 b
)
SELECT c.shop_order_id, c.order_number, c.tracking_id, c.pass, c.rule,
       round((extract(epoch FROM (c.created_at_mex - c.created_at)) / 3600)::numeric, 1),
       c.created_at, c.created_at_mex, c.status, c.payment_method, c.payment_status,
       c.total, c.cod_mkd, c.status_id, c.phone8
FROM np_cand c
WHERE (p_ids IS NULL OR c.shop_order_id = ANY (p_ids))
  AND (p_recent_days IS NULL OR c.created_at >= now() - make_interval(days => p_recent_days))
ORDER BY c.created_at, c.shop_order_id
$fn$;

COMMENT ON FUNCTION public.web_phone_link_candidates(integer[], integer) IS
  'The web order ↔ NATURA "M…" parcel pairs web_link_mex_parcels_by_phone would link now: same phone8, parcel 1 h before → 10 days after the order, COD = round(total) (or total + shipping) ±1 or COD 0 with the shop''s payment PAID, exactly one candidate on both sides (pass 1 ≤ 5 days, pass 2 ≤ 10 days over the rest); parcels held by a CRM order or claimed by a web order, and orders with a link or a waybill, never. Read-only. Migration 20260940000300.';

REVOKE ALL ON FUNCTION public.web_phone_link_candidates(integer[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_phone_link_candidates(integer[], integer) TO service_role;

-- ── 4. The phone matcher: the writer (web_orders only) ─────────────────────
-- p_ids NULL + p_recent_days N: web orders created in the last N days (NULL =
-- all, the nightly sweep and the one-off backfill). p_dry_run: count what it
-- would release and link, write nothing. Returns
--   {dry_run, candidates, linked, released, by_rule, by_pass, sample[≤ 20]}
-- (dry run: would_link / would_release instead of linked / released).
CREATE OR REPLACE FUNCTION public.web_link_mex_parcels_by_phone(
  p_ids         integer[] DEFAULT NULL,
  p_recent_days integer   DEFAULT 60,
  p_dry_run     boolean   DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _dry      boolean := coalesce(p_dry_run, false);
  _released integer := 0;
  _res      jsonb;
BEGIN
  IF NOT _dry THEN
    -- One linker at a time: an incremental run and a sweep may overlap.
    PERFORM pg_advisory_xact_lock(hashtext('public.web_link_mex_parcels_by_phone'));
  END IF;

  -- A phone link is the weakest evidence: it yields to a deterministic web
  -- claim on the same parcel, to a CRM order holding the parcel, and to a
  -- waybill of the order's own (web_link_mex_parcels then links that).
  IF _dry THEN
    SELECT count(*)::integer INTO _released
    FROM public.web_orders w
    WHERE w.mex_link_method = 'phone_amount'
      AND (w.tracking_number IS NOT NULL
           OR EXISTS (SELECT 1 FROM public.web_orders o
                       WHERE o.mex_tracking_id = w.mex_tracking_id AND o.shop_order_id <> w.shop_order_id
                         AND o.deleted_in_shop_at IS NULL AND o.mex_link_method IS DISTINCT FROM 'phone_amount')
           OR EXISTS (SELECT 1 FROM public.mex_parcels p
                       WHERE p.tracking_id = w.mex_tracking_id AND p.order_id IS NOT NULL)
           OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = w.mex_tracking_id));
  ELSE
    WITH rel AS (
      UPDATE public.web_orders w
         SET mex_tracking_id = NULL,
             mex_link_method = NULL,
             mex_linked_at   = NULL
       WHERE w.mex_link_method = 'phone_amount'
         AND (w.tracking_number IS NOT NULL
              OR EXISTS (SELECT 1 FROM public.web_orders o
                          WHERE o.mex_tracking_id = w.mex_tracking_id AND o.shop_order_id <> w.shop_order_id
                            AND o.deleted_in_shop_at IS NULL AND o.mex_link_method IS DISTINCT FROM 'phone_amount')
              OR EXISTS (SELECT 1 FROM public.mex_parcels p
                          WHERE p.tracking_id = w.mex_tracking_id AND p.order_id IS NOT NULL)
              OR EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = w.mex_tracking_id))
      RETURNING 1
    )
    SELECT count(*)::integer INTO _released FROM rel;
  END IF;

  -- The candidates see the released rows (a new statement, a new snapshot).
  WITH c AS MATERIALIZED (
    SELECT * FROM public.web_phone_link_candidates(p_ids, p_recent_days)
  ),
  upd AS (
    UPDATE public.web_orders w
       SET mex_tracking_id = c.tracking_id,
           mex_link_method = 'phone_amount',
           mex_linked_at   = now()
      FROM c
     WHERE NOT _dry
       AND w.shop_order_id = c.shop_order_id
       AND w.mex_tracking_id IS NULL          -- re-checked under the row lock
       AND w.tracking_number IS NULL
       AND w.deleted_in_shop_at IS NULL
    RETURNING w.shop_order_id
  )
  SELECT jsonb_build_object(
    'dry_run',    _dry,
    'candidates', (SELECT count(*) FROM c),
    CASE WHEN _dry THEN 'would_link' ELSE 'linked' END,
                  CASE WHEN _dry THEN (SELECT count(*) FROM c) ELSE (SELECT count(*) FROM upd) END,
    CASE WHEN _dry THEN 'would_release' ELSE 'released' END, _released,
    'by_rule',    coalesce((SELECT jsonb_object_agg(r.rule, r.n)
                              FROM (SELECT c.rule, count(*) AS n FROM c GROUP BY c.rule) r), '{}'::jsonb),
    'by_pass',    coalesce((SELECT jsonb_object_agg(r.pass::text, r.n)
                              FROM (SELECT c.pass, count(*) AS n FROM c GROUP BY c.pass) r), '{}'::jsonb),
    'sample',     coalesce((SELECT jsonb_agg(jsonb_build_object(
                                     'order_number', s.order_number, 'tracking_id', s.tracking_id,
                                     'rule', s.rule, 'pass', s.pass, 'hours_after', s.hours_after)
                                   ORDER BY s.web_created_at DESC)
                              FROM (SELECT * FROM c ORDER BY c.web_created_at DESC LIMIT 20) s), '[]'::jsonb))
  INTO _res;

  RETURN _res;
END;
$fn$;

COMMENT ON FUNCTION public.web_link_mex_parcels_by_phone(integer[], integer, boolean) IS
  'Links web orders to their OpenCart-era NATURA "M…" parcels by phone + time + amount (web_phone_link_candidates: exactly one candidate on both sides) as mex_link_method phone_amount, and first releases phone links that lost to stronger evidence (a deterministic web claim, a CRM order holding the parcel, the order''s own waybill). Writes web_orders only; idempotent. p_dry_run writes nothing. Called by web-sync after web_link_mex_parcels. Service role only. Migration 20260940000300.';

REVOKE ALL ON FUNCTION public.web_link_mex_parcels_by_phone(integer[], integer, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_link_mex_parcels_by_phone(integer[], integer, boolean) TO service_role;


-- ── 5. apply_no_parcel_rule — the days from no_parcel_rule_days() ─────────────
-- LIVE definition (= 20260938000000), two lines changed: _days reads the helper
-- (default 10 instead of 7 when the key is missing) and the cancellation note
-- says the rule's actual days. Scope, gates, ledger and actor are unchanged.

CREATE OR REPLACE FUNCTION public.apply_no_parcel_rule(_force boolean DEFAULT false, _dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  _days      := public.no_parcel_rule_days();   -- settings.days, default 10, never below 3
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
             cancellation_reason_notes = 'No MEX parcel ' || n.days_waiting || ' days after the AlterCPA approval (' || _days || '-day rule).'
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
$function$;


COMMENT ON FUNCTION public.apply_no_parcel_rule(boolean, boolean) IS
  '2026-09-28: the no-parcel rule. AlterCPA-confirmed orders with no MEX parcel N days after the sale (N = no_parcel_rule_days(): app_settings.no_parcel_rule.days, default 10): report mode → ledger only; apply mode → cancelled (no_parcel_7d — the stored code keeps its name) + order_history + note. Same-phone unlinked parcel → needs_linking, never cancelled. (_force) manual run, (_dry_run) writes nothing.';


-- ── 6. integrations_health — days_n from no_parcel_rule_days() ────────────────
-- LIVE definition (= 20260939000200), one expression changed (days_n; its
-- fallback was 7). Every threshold stays in step with insights_overview.

CREATE OR REPLACE FUNCTION public.integrations_health()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH v AS (
  SELECT now() AS now_ts,
         now() AT TIME ZONE 'Europe/Skopje' AS l,
         (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
         ((((now() AT TIME ZONE 'Europe/Skopje')::date) - 6)::timestamp AT TIME ZONE 'Europe/Skopje') AS since7
),
days AS (
  SELECT (v.today - g)::date AS d FROM v, generate_series(0, 6) g
),
-- The 07:00–20:55 Skopje crons: outside the working day "fresh" means "the
-- last run of the day happened". mex = fr_mex_expect of insights_overview.
expect AS (
  SELECT CASE WHEN v.l::time BETWEEN time '07:45' AND time '21:00' THEN v.now_ts
              WHEN v.l::time < time '07:45' THEN ((v.l::date - 1) + time '20:40') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '20:40') AT TIME ZONE 'Europe/Skopje' END AS mex,
         CASE WHEN v.l::time BETWEEN time '07:30' AND time '21:00' THEN v.now_ts
              WHEN v.l::time < time '07:30' THEN ((v.l::date - 1) + time '20:55') AT TIME ZONE 'Europe/Skopje'
              ELSE (v.l::date + time '20:55') AT TIME ZONE 'Europe/Skopje' END AS acpa_status
    FROM v
),
-- Every sync run of the last 7 Skopje days in one shape, keyed by the card it
-- belongs to (24 h counts and the strip). st: ok (web 'partial' counts, as in
-- the Overview) · failed · running; a run still running after 15 minutes is
-- hung = failed. MEX runs are shared by both accounts: an ok run counts for
-- the account it fetched (skipped ? fetched_<acct>, the Overview's test) with
-- that account's row count; a failed run fails BOTH (it stops before
-- matching, so no order moved).
feed_runs AS (
  SELECT x.fkey, x.job, x.started_at, x.rows_in,
         CASE WHEN x.st = 'running' AND x.started_at < v.now_ts - interval '15 minutes' THEN 'failed'
              ELSE x.st END AS st
    FROM v, (
      SELECT 'altercpa'::text AS fkey, r.kind AS job, r.started_at,
             coalesce(r.ledger_new, 0) AS rows_in,
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END AS st
        FROM public.altercpa_sync_runs r
        JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'mex_' || a.acct, r.kind, r.started_at,
             coalesce((r.skipped ->> ('fetched_' || a.acct))::integer, 0),
             CASE WHEN r.status = 'ok' THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.mex_sync_runs r
        JOIN (VALUES ('bio_natural'), ('natura')) a(acct)
          ON r.status <> 'ok' OR r.skipped ? ('fetched_' || a.acct)
       WHERE r.started_at >= (SELECT since7 FROM v)
      UNION ALL
      SELECT 'web', r.kind, r.started_at,
             coalesce(r.new_orders, 0) + coalesce(r.changed_orders, 0),
             CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' WHEN r.status = 'running' THEN 'running' ELSE 'failed' END
        FROM public.web_sync_runs r
       WHERE r.started_at >= (SELECT since7 FROM v)
    ) x
),
-- The jobs each card is expected to run (the cron.job schedules), plus any
-- other kind seen this week (a manual backfill …). An expected job that has
-- stopped running entirely still shows — as stale — instead of vanishing.
expected AS (
  SELECT * FROM (VALUES
    ('altercpa',        'rolling',     'rolling_2m'),
    ('altercpa',        'status',      'daytime_5m'),
    ('altercpa',        'nightly',     'nightly'),
    ('altercpa',        'weekly',      'weekly'),
    ('mex_bio_natural', 'rolling',     'daytime_30m'),
    ('mex_bio_natural', 'backfill',    'weekly'),
    ('mex_natura',      'rolling',     'daytime_30m'),
    ('mex_natura',      'backfill',    'weekly'),
    ('web',             'incremental', 'every_15m'),
    ('web',             'backfill',    'nightly')
  ) e(fkey, job, expect)
),
job_set AS (
  SELECT e.fkey, e.job, e.expect FROM expected e
  UNION
  SELECT DISTINCT f.fkey, f.job, 'manual' FROM feed_runs f
   WHERE NOT EXISTS (SELECT 1 FROM expected e WHERE e.fkey = f.fkey AND e.job = f.job)
),
-- Last ok / last settled / last failure per job, over ALL history, each an
-- index-backed "newest matching row" probe (altercpa_sync_runs:
-- (account_id, started_at DESC)); a chronically failing job costs a scan
-- back to its last success, nothing else does.
job_last AS (
  SELECT js.fkey, js.job, js.expect, lo.finished_at AS last_ok, ls.started_at AS last_settled_at, ls.st AS last_status,
         lf.started_at AS last_failed_at, left(lf.error, 1000) AS last_error
    FROM job_set js
    CROSS JOIN v
    LEFT JOIN LATERAL (
      (SELECT r.finished_at FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job AND r.status = 'ok'
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job AND r.status = 'ok'
          AND r.skipped ? ('fetched_' || substr(js.fkey, 5))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.finished_at FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job AND r.status IN ('ok', 'partial')
        ORDER BY r.started_at DESC LIMIT 1)
    ) lo ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
         FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END
         FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status <> 'ok' OR r.skipped ? ('fetched_' || substr(js.fkey, 5)))
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
         FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
        ORDER BY r.started_at DESC LIMIT 1)
    ) ls ON true
    LEFT JOIN LATERAL (
      (SELECT r.started_at, r.error FROM public.altercpa_sync_runs r
         JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
        WHERE js.fkey = 'altercpa' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, r.error FROM public.mex_sync_runs r
        WHERE left(js.fkey, 4) = 'mex_' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
      UNION ALL
      (SELECT r.started_at, coalesce(r.error, r.warning) FROM public.web_sync_runs r
        WHERE js.fkey = 'web' AND r.kind = js.job
          AND (r.status NOT IN ('ok', 'partial', 'running') OR (r.status = 'running' AND r.started_at <= v.now_ts - interval '15 minutes'))
        ORDER BY r.started_at DESC LIMIT 1)
    ) lf ON true
),
job_counts AS (
  SELECT f.fkey, f.job,
         max(f.started_at)                                                                          AS last_run_7d,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st <> 'running') AS runs_24h,
         count(*) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'failed')   AS failed_24h,
         coalesce(sum(f.rows_in) FILTER (WHERE f.started_at > v.now_ts - interval '24 hours' AND f.st = 'ok'), 0) AS rows_24h
    FROM feed_runs f, v
   GROUP BY f.fkey, f.job
),
jobs_status AS (
  SELECT jl.*,
         coalesce(jc.last_run_7d, jl.last_settled_at) AS last_run,
         coalesce(jc.runs_24h, 0) AS runs_24h, coalesce(jc.failed_24h, 0) AS failed_24h, coalesce(jc.rows_24h, 0) AS rows_24h,
         CASE
           WHEN jl.last_status = 'failed' THEN 'failing'
           WHEN jl.last_ok IS NULL THEN CASE WHEN jl.expect = 'manual' THEN 'n/a' ELSE 'failing' END
           WHEN jl.expect = 'rolling_2m'  AND jl.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_5m'  AND jl.last_ok < e.acpa_status - interval '30 minutes' THEN 'stale'
           WHEN jl.expect = 'daytime_30m' AND jl.last_ok < e.mex - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'every_15m'   AND jl.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
           WHEN jl.expect = 'nightly'     AND jl.last_ok < v.now_ts - interval '26 hours' THEN 'stale'
           WHEN jl.expect = 'weekly'      AND jl.last_ok < v.now_ts - interval '8 days' THEN 'stale'
           ELSE 'ok'
         END AS status
    FROM job_last jl
    LEFT JOIN job_counts jc ON jc.fkey = jl.fkey AND jc.job = jl.job
    CROSS JOIN v
    CROSS JOIN expect e
),
feed_agg AS (
  SELECT js.fkey,
         jsonb_agg(jsonb_build_object(
           'job', js.job, 'expect', js.expect, 'status', js.status,
           'last_ok_at', js.last_ok, 'last_run_at', js.last_run, 'last_run_status', js.last_status,
           'last_error', js.last_error, 'last_error_at', js.last_failed_at,
           'runs_24h', js.runs_24h, 'failed_24h', js.failed_24h, 'rows_24h', js.rows_24h)
           ORDER BY CASE js.job WHEN 'rolling' THEN 0 WHEN 'incremental' THEN 0 WHEN 'status' THEN 1
                                WHEN 'nightly' THEN 2 WHEN 'weekly' THEN 3 WHEN 'backfill' THEN 4 ELSE 5 END,
                    js.job) AS jobs,
         sum(js.runs_24h)       AS runs_24h,
         sum(js.failed_24h)     AS failed_24h,
         max(js.last_run)       AS last_run_at,
         max(js.last_failed_at) AS last_failed_at,
         (array_agg(js.last_error ORDER BY js.last_failed_at DESC NULLS LAST))[1] AS last_error
    FROM jobs_status js
   GROUP BY js.fkey
),
-- 7-day strip: settled runs per Skopje day.
strip AS (
  SELECT f.fkey, (f.started_at AT TIME ZONE 'Europe/Skopje')::date AS d,
         count(*) FILTER (WHERE f.st = 'ok')     AS ok,
         count(*) FILTER (WHERE f.st = 'failed') AS failed
    FROM feed_runs f
   GROUP BY 1, 2
),
strips AS (
  SELECT fk.k AS fkey,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM (VALUES ('altercpa'), ('mex_bio_natural'), ('mex_natura'), ('web')) fk(k)
    CROSS JOIN days d
    LEFT JOIN strip s ON s.fkey = fk.k AND s.d = d.d
   GROUP BY fk.k
),
-- ── headline statuses: the Overview's frj formulas ─────────────────────────
-- AlterCPA: the rolling job alone. MEX: last ok for the account in 10 days
-- (else the register's last sighting); last status = the newest settled MEX
-- run of any kind in 10 days (both cards share it, as in the Overview). Web:
-- any kind.
h_acpa AS (
  SELECT js.last_ok, js.last_status FROM jobs_status js WHERE js.fkey = 'altercpa' AND js.job = 'rolling'
),
mex_last AS (
  SELECT CASE WHEN r.status = 'ok' THEN 'ok' ELSE 'failed' END AS st
    FROM public.mex_sync_runs r, v
   WHERE r.started_at > v.now_ts - interval '10 days'
     AND NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
   ORDER BY r.started_at DESC
   LIMIT 1
),
parcels AS (
  SELECT p.account,
         max(p.last_seen_at)   AS last_seen,
         max(p.last_update_at) AS data_through,
         count(*) FILTER (WHERE p.created_at_mex > v.now_ts - interval '24 hours') AS parcels_new,
         count(*) FILTER (WHERE p.last_update_at > v.now_ts - interval '24 hours') AS parcels_moved,
         count(*) FILTER (WHERE p.delivered_at   > v.now_ts - interval '24 hours') AS delivered,
         count(*) FILTER (WHERE p.returned_at    > v.now_ts - interval '24 hours') AS returned
    FROM public.mex_parcels p, v
   GROUP BY p.account
),
h_mex AS (
  SELECT a.acct,
         coalesce((SELECT max(r.finished_at) FROM public.mex_sync_runs r, v
                    WHERE r.status = 'ok' AND r.started_at > v.now_ts - interval '10 days'
                      AND r.skipped ? ('fetched_' || a.acct)),
                  pc.last_seen) AS last_ok,
         (SELECT st FROM mex_last) AS last_status,
         pc.data_through,
         jsonb_build_object('parcels_new', coalesce(pc.parcels_new, 0), 'parcels_moved', coalesce(pc.parcels_moved, 0),
                            'delivered', coalesce(pc.delivered, 0), 'returned', coalesce(pc.returned, 0)) AS rows
    FROM (VALUES ('bio_natural'), ('natura')) a(acct)
    LEFT JOIN parcels pc ON pc.account = a.acct
),
h_web AS (
  SELECT (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')) AS last_ok,
         (SELECT CASE WHEN r.status IN ('ok', 'partial') THEN 'ok' ELSE 'failed' END
            FROM public.web_sync_runs r, v
           WHERE NOT (r.status = 'running' AND r.started_at > v.now_ts - interval '15 minutes')
           ORDER BY r.started_at DESC LIMIT 1) AS last_status
),
-- ── rows that came in ──────────────────────────────────────────────────────
r_acpa AS (
  SELECT count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours')                                  AS leads_new,
         count(*) FILTER (WHERE l.first_seen_at > v.now_ts - interval '24 hours' AND upper(coalesce(l.geo, '')) = 'MK') AS leads_mk,
         count(*) FILTER (WHERE l.first_seen_at >= (v.today::timestamp AT TIME ZONE 'Europe/Skopje'))             AS leads_today
    FROM public.altercpa_leads l, v
   WHERE l.first_seen_at > v.now_ts - interval '2 days'
),
r_acpa_runs AS (
  SELECT coalesce(sum(r.orders_created) FILTER (WHERE r.status = 'ok'), 0) AS orders_created,
         coalesce(sum(r.orders_updated) FILTER (WHERE r.status = 'ok'), 0) AS orders_updated
    FROM public.altercpa_sync_runs r
    JOIN public.altercpa_accounts a ON a.id = r.account_id AND a.is_active
    CROSS JOIN v
   WHERE r.started_at > v.now_ts - interval '24 hours'
),
r_web AS (
  SELECT (SELECT count(*) FROM public.web_orders w, v WHERE w.created_at > v.now_ts - interval '24 hours') AS orders_new,
         (SELECT coalesce(sum(r.changed_orders), 0) FROM public.web_sync_runs r, v
           WHERE r.started_at > v.now_ts - interval '24 hours' AND r.status IN ('ok', 'partial')) AS orders_changed
),
-- collabBox: whatever THE helper says (collabbox_feed_state, 6a above — the
-- Overview reads the same). It has no run log yet, so no runs and no strip:
-- documents are not runs.
cb AS (
  SELECT public.collabbox_feed_state() AS j
),
-- ── pg_cron ────────────────────────────────────────────────────────────────
-- job_run_details (never purged; 213k rows on 2026-09-28) has only its runid
-- primary key. runid is monotonic, so the newest 50.000 runs are a PK range
-- scan instead of a full-table seq scan — ~12 days at today's ~4.100 runs/day,
-- the 8 days read here with room for the schedule to grow by half. Past that
-- the strip's oldest days read short; they never read wrong.
cron_runs AS (
  SELECT d.jobid, d.status, d.start_time, d.end_time, d.return_message
    FROM cron.job_run_details d, v
   WHERE d.runid > (SELECT coalesce(max(x.runid), 0) - 50000 FROM cron.job_run_details x)
     AND d.start_time >= v.now_ts - interval '8 days'
),
cron_agg AS (
  SELECT c.jobid,
         max(c.start_time)                                                   AS last_start,
         max(c.start_time) FILTER (WHERE c.status = 'failed')               AS last_failed,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours') AS runs_24h,
         count(*) FILTER (WHERE c.start_time > v.now_ts - interval '24 hours' AND c.status = 'failed') AS failed_24h
    FROM cron_runs c, v
   GROUP BY c.jobid
),
cron_last AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.status, c.start_time, c.end_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_start
   ORDER BY a.jobid
),
cron_fail AS (
  SELECT DISTINCT ON (a.jobid) a.jobid, c.start_time, left(c.return_message, 1000) AS msg
    FROM cron_agg a JOIN cron_runs c ON c.jobid = a.jobid AND c.start_time = a.last_failed AND c.status = 'failed'
   ORDER BY a.jobid
),
cron_strip AS (
  SELECT j.jobid,
         jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.ok, 0), 'failed', coalesce(s.failed, 0))
                   ORDER BY d.d) AS days
    FROM cron.job j
    CROSS JOIN days d
    LEFT JOIN (SELECT c.jobid, (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d,
                      count(*) FILTER (WHERE c.status = 'succeeded') AS ok,
                      count(*) FILTER (WHERE c.status = 'failed')    AS failed
                 FROM cron_runs c, v
                WHERE c.start_time >= v.since7
                GROUP BY 1, 2) s ON s.jobid = j.jobid AND s.d = d.d
   GROUP BY j.jobid
),
cron_json AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'jobid', j.jobid, 'jobname', j.jobname, 'schedule', j.schedule, 'active', j.active,
           -- pg_cron "succeeded" on an invoke_* job only means the HTTP call was
           -- queued; the feed cards above say whether the sync itself worked.
           'status', CASE WHEN NOT j.active THEN 'n/a'
                          WHEN cl.jobid IS NULL THEN 'n/a'
                          WHEN cl.status = 'failed' THEN 'failing'
                          ELSE 'ok' END,
           'last_status', cl.status, 'last_start', cl.start_time, 'last_end', cl.end_time,
           'last_message', cl.msg,
           'last_error', cf.msg, 'last_error_at', cf.start_time,
           'runs_24h', coalesce(ca.runs_24h, 0), 'failed_24h', coalesce(ca.failed_24h, 0),
           'days', cs.days)
         ORDER BY j.jobname), '[]'::jsonb) AS j
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
    LEFT JOIN cron_fail cf ON cf.jobid = j.jobid
    LEFT JOIN cron_agg ca ON ca.jobid = j.jobid
    LEFT JOIN cron_strip cs ON cs.jobid = j.jobid
),
-- ── the no-parcel rule (days: app_settings, no_parcel_rule_days()) ─────────
np AS (
  SELECT c.cfg,
         coalesce(c.cfg ->> 'mode', 'report') AS mode,
         public.no_parcel_rule_days() AS days_n,
         coalesce((c.cfg ->> 'hour')::int, 21) AS hour_n
    FROM (SELECT coalesce((SELECT s.value FROM public.app_settings s WHERE s.key = 'no_parcel_rule'), '{}'::jsonb) AS cfg) c
),
np_runs AS (
  SELECT max(r.ran_at) AS last_any,
         max(r.ran_at) FILTER (WHERE r.trigger_kind = 'cron') AS last_cron,
         bool_or(r.run_day = v.today AND r.trigger_kind = 'cron') AS cron_today,
         count(*) FILTER (WHERE r.ran_at > v.now_ts - interval '24 hours') AS runs_24h
    FROM public.no_parcel_rule_runs r, v
),
np_slot AS (
  -- The scheduled slot (hour:10 Skopje — apply_no_parcel_rule's own gate)
  -- that should already have run, and the next one.
  SELECT np.*, nr.*,
         CASE WHEN v.l >= (v.today + make_time(np.hour_n, 10, 0))
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today - 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS last_slot,
         CASE WHEN v.l < (v.today + make_time(np.hour_n, 10, 0)) AND NOT coalesce(nr.cron_today, false)
              THEN (v.today + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje'
              ELSE ((v.today + 1) + make_time(np.hour_n, 10, 0)) AT TIME ZONE 'Europe/Skopje' END AS next_run
    FROM np CROSS JOIN np_runs nr CROSS JOIN v
),
np_job AS (
  SELECT j.jobid, j.active, cl.status AS last_status, cl.start_time, cl.msg
    FROM cron.job j
    LEFT JOIN cron_last cl ON cl.jobid = j.jobid
   WHERE j.jobname = 'no-parcel-rule'
   LIMIT 1
),
np_strip AS (
  SELECT jsonb_agg(jsonb_build_object('d', d.d, 'ok', coalesce(s.n, 0), 'failed', coalesce(f.n, 0),
                                      'to_cancel', s.to_cancel, 'cancelled', s.cancelled)
                   ORDER BY d.d) AS days
    FROM days d
    LEFT JOIN (SELECT r.run_day AS d, count(*) AS n,
                      (array_agg(r.to_cancel ORDER BY r.ran_at DESC))[1] AS to_cancel,
                      sum(r.cancelled) AS cancelled
                 FROM public.no_parcel_rule_runs r, v
                WHERE r.run_day >= v.today - 6
                GROUP BY r.run_day) s ON s.d = d.d
    LEFT JOIN (SELECT (c.start_time AT TIME ZONE 'Europe/Skopje')::date AS d, count(*) AS n
                 FROM cron_runs c JOIN np_job nj ON nj.jobid = c.jobid
                WHERE c.status = 'failed'
                GROUP BY 1) f ON f.d = d.d
),
np_json AS (
  SELECT jsonb_build_object(
    'key', 'no_parcel_rule',
    'settings', s.cfg,
    'mode', s.mode,
    'days_n', s.days_n,
    'hour', s.hour_n,
    'status', CASE WHEN nj.jobid IS NULL OR NOT nj.active THEN 'n/a'
                   WHEN nj.last_status = 'failed' THEN 'failing'
                   -- nothing ran since the slot that should have (20 min grace)
                   WHEN v.now_ts > s.last_slot + interval '20 minutes'
                        AND coalesce(s.last_any, '-infinity'::timestamptz) < s.last_slot - interval '10 minutes' THEN 'stale'
                   ELSE 'ok' END,
    'last_ok_at', s.last_any,
    'last_cron_run_at', s.last_cron,
    'next_run_at', s.next_run,
    'last_run', (SELECT to_jsonb(r) - 'settings' FROM public.no_parcel_rule_runs r ORDER BY r.ran_at DESC LIMIT 1),
    'cron_last_status', nj.last_status,
    'cron_last_at', nj.start_time,
    'last_error', CASE WHEN nj.last_status = 'failed' THEN nj.msg END,
    'runs_24h', s.runs_24h,
    'days', (SELECT days FROM np_strip)) AS j
    FROM np_slot s
    CROSS JOIN v
    LEFT JOIN np_job nj ON true
),
feed_json AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_build_object(
       'key', 'altercpa',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '15 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('leads_new', ra.leads_new, 'leads_mk', ra.leads_mk,
                                  'orders_created', rr.orders_created, 'orders_updated', rr.orders_updated),
       'leads_today', ra.leads_today,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_acpa ra CROSS JOIN r_acpa_runs rr
       LEFT JOIN h_acpa h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'altercpa'
       LEFT JOIN strips st ON st.fkey = 'altercpa'),
    (SELECT jsonb_build_object(
       'key', 'mex_bio_natural',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_bio_natural'
       LEFT JOIN strips st ON st.fkey = 'mex_bio_natural'
      WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'key', 'mex_natura',
       'status', CASE WHEN m.last_ok IS NULL THEN 'failing'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failing'
                      WHEN m.last_ok < e.mex - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', m.last_ok, 'data_through', m.data_through,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', m.rows,
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM h_mex m CROSS JOIN expect e
       LEFT JOIN feed_agg fa ON fa.fkey = 'mex_natura'
       LEFT JOIN strips st ON st.fkey = 'mex_natura'
      WHERE m.acct = 'natura'),
    (SELECT jsonb_build_object(
       'key', 'web',
       'status', CASE WHEN h.last_ok IS NULL THEN 'failing'
                      WHEN h.last_status = 'failed' THEN 'failing'
                      WHEN h.last_ok < v.now_ts - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'last_ok_at', h.last_ok,
       'last_run_at', fa.last_run_at,
       'last_error', fa.last_error, 'last_error_at', fa.last_failed_at,
       'runs_24h', coalesce(fa.runs_24h, 0), 'failed_24h', coalesce(fa.failed_24h, 0),
       'rows', jsonb_build_object('orders_new', rw.orders_new, 'orders_changed', rw.orders_changed),
       'jobs', coalesce(fa.jobs, '[]'::jsonb),
       'days', st.days)
       FROM v CROSS JOIN r_web rw
       LEFT JOIN h_web h ON true
       LEFT JOIN feed_agg fa ON fa.fkey = 'web'
       LEFT JOIN strips st ON st.fkey = 'web'),
    (SELECT jsonb_build_object(
       'key', 'collabbox',
       -- the helper speaks the Overview's words (failed); this page says failing
       'status', CASE WHEN c.j ->> 'status' = 'failed' THEN 'failing'
                      WHEN c.j ->> 'status' IN ('ok', 'stale', 'failing') THEN c.j ->> 'status'
                      ELSE 'n/a' END,
       'last_ok_at', c.j -> 'last_ok_at', 'data_through', c.j -> 'data_through',
       'detail', c.j -> 'detail',
       'last_run_at', NULL, 'last_error', NULL, 'last_error_at', NULL,
       'runs_24h', 0, 'failed_24h', 0,
       'rows', jsonb_build_object('lag_parcels', coalesce((c.j ->> 'lag_parcels')::bigint, 0)),
       'jobs', '[]'::jsonb,
       'days', NULL)
       FROM cb c)
  ) AS j
)
SELECT jsonb_build_object(
  'generated_at', (SELECT now_ts FROM v),
  'today', (SELECT today FROM v),
  'feeds', (SELECT j FROM feed_json),
  'no_parcel', (SELECT j FROM np_json),
  'cron', (SELECT j FROM cron_json)
);
$function$;


-- ── 7. insights_overview — test phones out, attention days from the setting ───
-- LIVE definition (= 20260936000000). Changed: v_excluded / v_np_days read once;
-- the waiting-web-orders probe drops test phones; the core gets $12 (the test
-- phones) and $13 (the rule's days): CTEs xtp / xto (test parcels / test
-- orders), f (every order figure: kpis, sources, trend, teams, cm), mf
-- (MEX-only parcels: cash, ul), vw (the work ledger: teams, night / burst
-- approvals), anp (N days instead of 7, + test orders) and mp (+ test
-- orders); the approved_no_parcel_7d item carries `days`. The web block is
-- insights_web_block (section 8). overview.ts attentionFilter is the twin of
-- anp / mp (days + the same test-phone exclusion) — change them together.

CREATE OR REPLACE FUNCTION public.insights_overview(p_from text, p_to_end text, p_prev_from text DEFAULT NULL::text, p_prev_to_end text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_from      timestamptz;
  v_to        timestamptz;
  v_pf        timestamptz;
  v_pt        timestamptz;
  v_web       jsonb;
  v_web_prev  jsonb;
  v_web_fresh jsonb;
  v_web_err   text;
  v_claimed   text[];
  v_waiting   jsonb;
  v_excluded  text[];
  v_np_days   integer;
  v_out       jsonb;
BEGIN
  IF nullif(btrim(coalesce(p_from, '')), '') IS NULL OR nullif(btrim(coalesce(p_to_end, '')), '') IS NULL THEN
    RAISE EXCEPTION 'insights_overview: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  v_from := p_from::timestamptz;
  v_to   := p_to_end::timestamptz;
  IF v_to < v_from THEN
    RAISE EXCEPTION 'insights_overview: p_to_end is before p_from' USING ERRCODE = '22023';
  END IF;
  IF v_to - v_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_overview: window longer than 800 days' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(coalesce(p_prev_from, '')), '') IS NOT NULL
     AND nullif(btrim(coalesce(p_prev_to_end, '')), '') IS NOT NULL THEN
    v_pf := p_prev_from::timestamptz;
    v_pt := p_prev_to_end::timestamptz;
    IF v_pt < v_pf OR v_pt - v_pf > interval '800 days' THEN
      v_pf := NULL; v_pt := NULL;
    END IF;
  END IF;

  -- The owner's test phones (public.report_excluded_phones, 20260939000700):
  -- read once and handed to every query below as a constant — the
  -- foundation's rule (20260940000000): their parcels, and every order / web
  -- order on such a phone or holding such a parcel, are in no number here.
  v_excluded := public.report_excluded_phone8s();
  -- The no-parcel rule's days (app_settings.no_parcel_rule.days, default 10,
  -- never below 3): the same helper apply_no_parcel_rule() and GET
  -- /orders?attention=approved_no_parcel_7d read (20260940000300).
  v_np_days := public.no_parcel_rule_days();

  -- The web shop mirror, when the web-sync migrations have landed. Dynamic on
  -- purpose: this function must install and run before they exist.
  IF to_regprocedure('public.insights_web_block(text,text)') IS NOT NULL THEN
    BEGIN
      EXECUTE 'SELECT public.insights_web_block($1, $2)' INTO v_web USING p_from, p_to_end;
      IF v_pf IS NOT NULL THEN
        EXECUTE 'SELECT public.insights_web_block($1, $2)' INTO v_web_prev USING p_prev_from, p_prev_to_end;
      END IF;
      IF v_web IS NOT NULL AND jsonb_typeof(v_web) <> 'object' THEN v_web := NULL; END IF;
      IF v_web_prev IS NOT NULL AND jsonb_typeof(v_web_prev) <> 'object' THEN v_web_prev := NULL; END IF;
    EXCEPTION WHEN OTHERS THEN
      v_web := NULL; v_web_prev := NULL; v_web_err := left(SQLERRM, 200);
    END;
  END IF;

  -- web_sync_runs (20260937000000): status running | ok | partial | failed.
  IF to_regclass('public.web_sync_runs') IS NOT NULL THEN
    BEGIN
      EXECUTE $w$
        SELECT jsonb_build_object(
          'last_ok_at',  (SELECT max(r.finished_at) FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')),
          'last_status', (SELECT r.status FROM public.web_sync_runs r
                           WHERE r.status <> 'running' ORDER BY r.started_at DESC LIMIT 1),
          'last_error',  (SELECT left(r.error, 200) FROM public.web_sync_runs r
                           WHERE r.status = 'failed' ORDER BY r.started_at DESC LIMIT 1))
      $w$ INTO v_web_fresh;
    EXCEPTION WHEN OTHERS THEN
      v_web_fresh := jsonb_build_object('error', left(SQLERRM, 200));
    END;
  END IF;

  -- web_orders (20260937000000): the parcels web orders claim (they are web
  -- sales, never teleshop MEX-only), and web orders still not handed to the
  -- courier a day after they were placed (last 60 days; older never-closed
  -- OpenCart rows are history, not a queue).
  IF to_regclass('public.web_orders') IS NOT NULL THEN
    BEGIN
      EXECUTE $w$
        SELECT array_agg(DISTINCT w.mex_tracking_id)
        FROM public.web_orders w
        WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
      $w$ INTO v_claimed;
      EXECUTE $w$
        SELECT jsonb_build_object('count', count(*), 'value_mkd', coalesce(sum(w.total), 0),
                                  'oldest_at', min(w.created_at))
        FROM public.web_orders w
        WHERE w.deleted_in_shop_at IS NULL
          AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) IN ('awaiting', 'preparing')
          AND w.created_at <  now() - interval '24 hours'
          AND w.created_at >= now() - interval '60 days'
          AND NOT public.insights_excluded8(w.phone8, $1::text[])
      $w$ INTO v_waiting USING v_excluded;
    EXCEPTION WHEN OTHERS THEN
      v_claimed := NULL; v_waiting := NULL;
    END;
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 web block ·
  -- $6 web block (prev) · $7 web_sync_runs summary · $8 web block error ·
  -- $9 long window (> 31 days: history lookup scans once instead of probing) ·
  -- $10 MEX tracking ids web orders claim · $11 web orders waiting > 24 h ·
  -- $12 the test phones' last-8 digits · $13 the no-parcel rule's days
  EXECUTE $core$
WITH
prm AS (
  SELECT z.f, z.t, z.pf, z.pt,
         (z.f AT TIME ZONE 'Europe/Skopje')::date AS fd,
         (z.t AT TIME ZONE 'Europe/Skopje')::date AS td
  FROM (SELECT $1::timestamptz AS f, $2::timestamptz AS t,
               $3::timestamptz AS pf, $4::timestamptz AS pt) z
),
win1 AS (
  SELECT p.*,
         (p.td - p.fd + 1)                                               AS ndays,
         CASE WHEN p.td - p.fd + 1 <= 62 THEN 'day' ELSE 'month' END      AS gran,
         -- The spark always shows at least 14 Skopje days, so one day has context.
         CASE WHEN p.td - p.fd + 1 >= 14 THEN p.fd ELSE p.td - 13 END     AS sfd
  FROM prm p
),
win AS (
  SELECT w.*,
         least(w.f, (w.sfd::timestamp AT TIME ZONE 'Europe/Skopje'))      AS sf,
         CASE WHEN w.td - w.sfd + 1 <= 62 THEN 'day' ELSE 'month' END     AS sgran,
         least(w.f, coalesce(w.pf, w.f), (w.sfd::timestamp AT TIME ZONE 'Europe/Skopje')) AS w0,
         CASE WHEN w.td - w.fd + 1 <= 62 THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt,
         CASE WHEN w.td - w.sfd + 1 <= 62 THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt
  FROM win1 w
),
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('web', 3), ('teleshop_other', 4)) v(src, ord)
),
bks AS (
  SELECT * FROM (VALUES ('awaiting', 1), ('preparing', 2), ('packed', 3), ('courier', 4),
                        ('delivered', 5), ('returned', 6), ('cancelled', 7), ('trashed', 8)) v(bucket, ord)
),

-- ── the owner's test phones ($12, public.report_excluded_phones) ──────────
-- Their parcels, and every order on such a phone or holding such a parcel:
-- in no figure below (the foundation's rule, 20260940000000). The phone
-- expression is idx_orders_phone_last8's, so this is an index probe.
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($12::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($12::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),

-- ── every order any clock of any window can reach — scanned ONCE, and ────
-- materialised once with its three clocks, its bucket and its window flags.
f AS MATERIALIZED (
  SELECT d.*,
         (d.created_at BETWEEN w.f  AND w.t)  AS in_cur,
         (d.created_at BETWEEN w.pf AND w.pt) AS in_prev,
         (d.sale_at    BETWEEN w.f  AND w.t)  AS sale_cur,
         (d.sale_at    BETWEEN w.pf AND w.pt) AS sale_prev,
         (d.cash_at    BETWEEN w.f  AND w.t)  AS cash_cur,
         (d.cash_at    BETWEEN w.pf AND w.pt) AS cash_prev,
         (d.created_at BETWEEN w.sf AND w.t)  AS in_spark,
         (d.cash_at    BETWEEN w.sf AND w.t)  AS cash_spark,
         (d.created_at AT TIME ZONE 'Europe/Skopje')::date AS cday,
         (d.cash_at    AT TIME ZONE 'Europe/Skopje')::date AS kday
  FROM (
    SELECT o.*,
           CASE WHEN o.is_sale THEN coalesce(o.sold_at, o.confirmed_at, o.created_at) END AS sale_at,
           CASE WHEN o.bucket = 'delivered' THEN coalesce(o.mex_delivered_at, o.paid_at, o.created_at) END AS cash_at,
           CASE WHEN o.bucket = 'delivered' THEN
                CASE WHEN o.mex_delivered_at IS NOT NULL AND o.mex_cod_mkd IS NOT NULL
                     THEN o.mex_cod_mkd::numeric ELSE round(o.price * 61.5) END END       AS cash_mkd,
           (o.bucket = 'delivered' AND o.mex_delivered_at IS NOT NULL)                     AS proven,
           (o.bucket IN ('cancelled', 'trashed') AND o.sold_at IS NOT NULL)                AS lost_after_confirm,
           CASE WHEN o.bucket IN ('courier', 'returned')
                THEN coalesce(o.mex_cod_mkd::numeric, round(o.price * 61.5)) END         AS parcel_mkd
    FROM (
  SELECT x.id, x.display_id, x.status::text AS status,
         coalesce(x.price, 0)::numeric AS price,
         x.sale_source, x.sale_source_detail,
         CASE WHEN x.sale_source IN ('altercpa', 'affiliate') THEN 'altercpa'
              WHEN x.sale_source = 'elyon_crm'                THEN 'elyon_crm'
              WHEN x.sale_source = 'web'                      THEN 'web'
              ELSE 'teleshop_other' END                       AS src,
         x.created_at, x.sold_at, x.confirmed_at, x.sold_by_person_id, x.paid_at,
         x.mex_delivered_at, x.mex_returned_at, x.mex_cod_mkd,
         x.customer_phone,
         CASE WHEN x.status IN ('pending', 'take', 'call_again', 'duplicated') THEN 'awaiting'
              WHEN x.status = 'confirmed' AND x.packed_at IS NOT NULL      THEN 'packed'
              WHEN x.status = 'confirmed'                                  THEN 'preparing'
              WHEN x.status = 'shipped'                                    THEN 'courier'
              WHEN x.status IN ('paid', 'delivered')                       THEN 'delivered'
              WHEN x.status = 'returned'                                   THEN 'returned'
              WHEN x.status = 'cancelled'                                  THEN 'cancelled'
              WHEN x.status = 'trashed'                                    THEN 'trashed'
              ELSE 'awaiting' END                                          AS bucket,
         (coalesce(x.sale_source_detail, '') <> 'disposition'
          AND (x.sold_at IS NOT NULL
               OR x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))) AS is_sale
  FROM public.orders x, win w
  WHERE (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
    AND (   x.created_at       BETWEEN w.w0 AND w.t
         OR x.sold_at          BETWEEN w.w0 AND w.t
         OR (x.sold_at IS NULL AND x.confirmed_at BETWEEN w.w0 AND w.t)
         OR x.mex_delivered_at BETWEEN w.w0 AND w.t
         OR x.mex_returned_at  BETWEEN w.w0 AND w.t
         OR x.paid_at          BETWEEN w.w0 AND w.t)
    AND x.id NOT IN (SELECT xto.id FROM xto)
    ) o
  ) d, win w
),

-- ── delivered MEX parcels no order owns ────────────────────────────────────
mf AS MATERIALIZED (
  SELECT m.*,
         (m.created_at_mex BETWEEN w.f  AND w.t)  AS in_cur,
         (m.created_at_mex BETWEEN w.pf AND w.pt) AS in_prev,
         (m.delivered_at   BETWEEN w.f  AND w.t)  AS cash_cur,
         (m.delivered_at   BETWEEN w.pf AND w.pt) AS cash_prev,
         (m.delivered_at   BETWEEN w.sf AND w.t)  AS cash_spark,
         (m.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS kday
  FROM (
    SELECT p.tracking_id, p.account, p.series, coalesce(p.cod_mkd, 0)::numeric AS cod_mkd,
           p.created_at_mex, p.delivered_at,
           coalesce(p.tracking_id = ANY ($10::text[]), false) AS claimed,
           CASE WHEN coalesce(p.sender_reference, '') ~ '^NTMK' OR p.tracking_id ~ '^NTMK'
                     OR coalesce(p.tracking_id = ANY ($10::text[]), false)
                THEN 'web' ELSE 'teleshop_other' END AS src
    FROM public.mex_parcels p, win w
    WHERE p.order_id IS NULL AND p.status_id = 2
      AND (p.delivered_at BETWEEN w.w0 AND w.t OR p.created_at_mex BETWEEN w.w0 AND w.t)
      AND NOT public.insights_excluded8(p.phone8, $12::text[])
  ) m, win w
),

-- ── the web shop mirror (optional) ─────────────────────────────────────────
wbk AS (
  SELECT e.per, e.k AS bucket,
         coalesce(public.overview_jnum(CASE WHEN jsonb_typeof(e.v) = 'object' THEN e.v -> 'count' ELSE e.v END), 0) AS n,
         coalesce(public.overview_jnum(CASE WHEN jsonb_typeof(e.v) = 'object'
                                            THEN coalesce(e.v -> 'value_mkd', e.v -> 'mkd', e.v -> 'cod_mkd') END), 0) AS mkd
  FROM (
    SELECT 'cur' AS per, j.key AS k, j.value AS v
    FROM jsonb_each(CASE WHEN jsonb_typeof($5::jsonb -> 'buckets') = 'object' THEN $5::jsonb -> 'buckets' ELSE '{}'::jsonb END) j
    UNION ALL
    SELECT 'prev', j.key, j.value
    FROM jsonb_each(CASE WHEN jsonb_typeof($6::jsonb -> 'buckets') = 'object' THEN $6::jsonb -> 'buckets' ELSE '{}'::jsonb END) j
  ) e
),
wsum AS (
  SELECT per,
         CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END IS NOT NULL                      AS present,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{placed,count}'), 0)         AS placed_n,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{placed,value_mkd}'), 0)     AS placed_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,collected_mkd}'), 0)  AS coll_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,to_collect_mkd}'), 0) AS tc_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,lost_mkd}'), 0)       AS lost_mkd,
         coalesce(public.overview_jnum(CASE per WHEN 'cur' THEN $5::jsonb ELSE $6::jsonb END #> '{money,unrecorded_mkd}'), 0) AS unrec_mkd
  FROM (VALUES ('cur'), ('prev')) v(per)
),
wday AS (
  SELECT e ->> 'd' AS d,
         coalesce(public.overview_jnum(e -> 'placed_count'), 0)     AS n,
         coalesce(public.overview_jnum(e -> 'placed_value_mkd'), 0) AS mkd
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof($5::jsonb -> 'daily') = 'array' THEN $5::jsonb -> 'daily' ELSE '[]'::jsonb END) e
  WHERE jsonb_typeof(e) = 'object' AND (e ->> 'd') ~ '^\d{4}-\d{2}-\d{2}$'
),

-- ── per-source aggregates over the order rows ─────────────────────────────
-- Pre-aggregated to (source × bucket × every flag) first — a few hundred
-- rows — so the forty FILTERed sums below never touch 100k order rows.
g AS (
  SELECT f.src, f.bucket, f.is_sale, f.proven, f.lost_after_confirm,
         coalesce(f.in_cur, false)    AS in_cur,   coalesce(f.in_prev, false)   AS in_prev,
         coalesce(f.sale_cur, false)  AS sale_cur, coalesce(f.sale_prev, false) AS sale_prev,
         coalesce(f.cash_cur, false)  AS cash_cur, coalesce(f.cash_prev, false) AS cash_prev,
         count(*) AS n, coalesce(sum(f.price), 0) AS eur,
         coalesce(sum(f.cash_mkd), 0) AS cash_mkd, coalesce(sum(f.parcel_mkd), 0) AS parcel_mkd
  FROM f GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11
),
so AS (
  SELECT g.src,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur), 0)                                        AS placed_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur), 0)                                        AS placed_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev), 0)                                       AS p_placed_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev), 0)                                       AS p_placed_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur AND g.bucket <> 'awaiting'), 0)             AS worked,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur AND g.is_sale), 0)                          AS cohort_sold,
    coalesce(sum(g.n)   FILTER (WHERE g.sale_cur), 0)                                      AS conf_n,
    coalesce(sum(g.eur) FILTER (WHERE g.sale_cur), 0)                                      AS conf_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.sale_prev), 0)                                     AS p_conf_n,
    coalesce(sum(g.eur) FILTER (WHERE g.sale_prev), 0)                                     AS p_conf_eur,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.in_cur AND g.bucket = 'delivered'), 0)        AS coll_mkd,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.in_cur AND g.proven), 0)                      AS coll_proven_mkd,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur  AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS tc_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur  AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS tc_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS p_tc_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev AND g.bucket IN ('preparing', 'packed', 'courier')), 0) AS p_tc_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_cur  AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS lost_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_cur  AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS lost_eur,
    coalesce(sum(g.n)   FILTER (WHERE g.in_prev AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS p_lost_n,
    coalesce(sum(g.eur) FILTER (WHERE g.in_prev AND (g.bucket = 'returned' OR g.lost_after_confirm)), 0) AS p_lost_eur,
    coalesce(sum(g.n)          FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_n,
    coalesce(sum(g.eur)        FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_eur,
    coalesce(sum(g.parcel_mkd) FILTER (WHERE g.in_cur  AND g.bucket = 'courier'), 0)       AS cour_mkd,
    coalesce(sum(g.n)          FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_n,
    coalesce(sum(g.eur)        FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_eur,
    coalesce(sum(g.parcel_mkd) FILTER (WHERE g.in_prev AND g.bucket = 'courier'), 0)       AS p_cour_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_cur), 0)                                 AS cash_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_cur), 0)                                 AS cash_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_cur AND g.proven), 0)                    AS cash_proven_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_cur AND g.proven), 0)                    AS cash_proven_mkd,
    coalesce(sum(g.eur)      FILTER (WHERE g.cash_cur AND NOT g.proven), 0)                AS unproven_eur,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_prev), 0)                                AS p_cash_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_prev), 0)                                AS p_cash_mkd,
    coalesce(sum(g.n)        FILTER (WHERE g.cash_prev AND g.proven), 0)                   AS p_cash_proven_n,
    coalesce(sum(g.cash_mkd) FILTER (WHERE g.cash_prev AND g.proven), 0)                   AS p_cash_proven_mkd,
    coalesce(sum(g.eur)      FILTER (WHERE g.cash_prev AND NOT g.proven), 0)               AS p_unproven_eur
  FROM g GROUP BY g.src
),
ms AS (
  SELECT m.src,
    count(*) FILTER (WHERE m.in_cur AND NOT m.claimed)                    AS coh_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.in_cur AND NOT m.claimed), 0) AS coh_mkd,
    count(*) FILTER (WHERE m.cash_cur)                      AS cash_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.cash_cur), 0)   AS cash_mkd,
    count(*) FILTER (WHERE m.cash_prev)                     AS p_cash_n,
    coalesce(sum(m.cod_mkd) FILTER (WHERE m.cash_prev), 0)  AS p_cash_mkd
  FROM mf m GROUP BY m.src
),
s AS (
  SELECT sr.src, sr.ord,
    coalesce(so.placed_n, 0) AS placed_n, coalesce(so.placed_eur, 0) AS placed_eur,
    coalesce(so.p_placed_n, 0) AS p_placed_n, coalesce(so.p_placed_eur, 0) AS p_placed_eur,
    coalesce(so.worked, 0) AS worked, coalesce(so.cohort_sold, 0) AS cohort_sold,
    coalesce(so.conf_n, 0) AS conf_n, coalesce(so.conf_eur, 0) AS conf_eur,
    coalesce(so.p_conf_n, 0) AS p_conf_n, coalesce(so.p_conf_eur, 0) AS p_conf_eur,
    coalesce(so.coll_mkd, 0) + coalesce(ms.coh_mkd, 0) AS coll_mkd,
    coalesce(so.coll_proven_mkd, 0) + coalesce(ms.coh_mkd, 0) AS coll_proven_mkd,
    coalesce(so.tc_n, 0) AS tc_n, coalesce(so.tc_eur, 0) AS tc_eur,
    coalesce(so.p_tc_n, 0) AS p_tc_n, coalesce(so.p_tc_eur, 0) AS p_tc_eur,
    coalesce(so.lost_n, 0) AS lost_n, coalesce(so.lost_eur, 0) AS lost_eur,
    coalesce(so.p_lost_n, 0) AS p_lost_n, coalesce(so.p_lost_eur, 0) AS p_lost_eur,
    coalesce(so.cour_n, 0) AS cour_n, coalesce(so.cour_eur, 0) AS cour_eur, coalesce(so.cour_mkd, 0) AS cour_mkd,
    coalesce(so.p_cour_n, 0) AS p_cour_n, coalesce(so.p_cour_eur, 0) AS p_cour_eur, coalesce(so.p_cour_mkd, 0) AS p_cour_mkd,
    coalesce(so.cash_n, 0) AS o_cash_n, coalesce(so.cash_mkd, 0) AS o_cash_mkd,
    coalesce(so.cash_proven_n, 0) AS cash_proven_n, coalesce(so.cash_proven_mkd, 0) AS cash_proven_mkd,
    coalesce(so.unproven_eur, 0) AS unproven_eur,
    coalesce(so.p_cash_n, 0) AS p_o_cash_n, coalesce(so.p_cash_mkd, 0) AS p_o_cash_mkd,
    coalesce(so.p_cash_proven_n, 0) AS p_cash_proven_n, coalesce(so.p_cash_proven_mkd, 0) AS p_cash_proven_mkd,
    coalesce(so.p_unproven_eur, 0) AS p_unproven_eur,
    coalesce(ms.coh_n, 0) AS mo_coh_n, coalesce(ms.coh_mkd, 0) AS mo_coh_mkd,
    coalesce(ms.cash_n, 0) AS mo_cash_n, coalesce(ms.cash_mkd, 0) AS mo_cash_mkd,
    coalesce(ms.p_cash_n, 0) AS p_mo_cash_n, coalesce(ms.p_cash_mkd, 0) AS p_mo_cash_mkd
  FROM srcs sr
  LEFT JOIN so ON so.src = sr.src
  LEFT JOIN ms ON ms.src = sr.src
),

-- ── outcome buckets per source (PLACED clock) ──────────────────────────────
sb AS (
  SELECT u.src, u.bucket, sum(u.n) AS n, sum(u.eur) AS eur, sum(u.mkd) AS mkd, sum(u.proven_n) AS proven_n
  FROM (
    SELECT g.src, g.bucket, sum(g.n) AS n, sum(g.eur) AS eur,
           sum(CASE WHEN g.bucket = 'delivered' THEN g.cash_mkd ELSE g.parcel_mkd END) AS mkd,
           coalesce(sum(g.n) FILTER (WHERE g.proven), 0) AS proven_n
    FROM g WHERE g.in_cur GROUP BY 1, 2
    UNION ALL
    -- the web shop mirror's buckets (shop rules; its money is in denari)
    SELECT 'web', b.bucket, b.n, b.mkd / 61.5, b.mkd, 0
    FROM wbk b WHERE b.per = 'cur'
  ) u
  GROUP BY 1, 2
),
sbj AS MATERIALIZED (   -- read per source by a correlated sub-select: evaluate once
  SELECT k.src,
    jsonb_object_agg(k.bucket,
      jsonb_strip_nulls(jsonb_build_object(
        'count',       coalesce(sb.n, 0),
        'value_eur',   round(coalesce(sb.eur, 0), 2),
        'cod_mkd',     CASE WHEN k.bucket IN ('courier', 'delivered', 'returned') THEN round(coalesce(sb.mkd, 0)) END,
        'proven_count', CASE WHEN k.bucket = 'delivered' THEN coalesce(sb.proven_n, 0) END))) AS j
  FROM (SELECT sr.src, bk.bucket FROM srcs sr CROSS JOIN bks bk
        UNION SELECT sb.src, sb.bucket FROM sb) k          -- + the shop's no_record
  LEFT JOIN sb ON sb.src = k.src AND sb.bucket = k.bucket
  GROUP BY k.src
),

-- ── customer history for the AlterCPA cohort ──────────────────────────────
-- "Returning" = an EARLIER order on the same last-8 phone, any source, any
-- outcome, all time (never windowed: history does not start at the range
-- edge). The phone expression below is character-for-character the one
-- idx_orders_phone_last8 indexes, so a short window probes the index for its
-- few phones and a long one hash-joins a single pass over the table.
ap8 AS MATERIALIZED (
  SELECT f.id, f.created_at, f.price, f.bucket,
         right(regexp_replace(coalesce(f.customer_phone, ''), '[^0-9]', '', 'g'), 8) AS p8
  FROM f
  WHERE f.in_cur AND f.src = 'altercpa'
),
fo AS MATERIALIZED (
  -- long window ($9): one pass over the whole table, then a hash join
  SELECT y.p8, min(y.created_at) AS first_at, min(y.created_at) FILTER (WHERE y.paid) AS first_paid_at
  FROM (
    SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8, x.created_at,
           (x.status IN ('paid', 'delivered')) AS paid
    FROM public.orders x
    WHERE $9::boolean
      AND x.customer_phone IS NOT NULL
      AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
  ) y
  GROUP BY y.p8
  UNION ALL
  -- short window: probe idx_orders_phone_last8 for the cohort's phones only
  SELECT y.p8, min(y.created_at), min(y.created_at) FILTER (WHERE y.paid)
  FROM (
    SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8, x.created_at,
           (x.status IN ('paid', 'delivered')) AS paid
    FROM public.orders x
    WHERE NOT $9::boolean
      AND right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) IN
            (SELECT a.p8 FROM ap8 a WHERE length(a.p8) = 8)
      AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
  ) y
  GROUP BY y.p8
),
spl AS (
  SELECT 'altercpa'::text AS src,
         CASE WHEN fo.first_at < a.created_at THEN 'returning' ELSE 'new' END AS k,
         'placed'::text AS basis, NULL::text AS sale_source, NULL::text AS detail,
         count(*) AS n, sum(a.price) AS eur, NULL::numeric AS mkd,
         count(*) FILTER (WHERE fo.first_paid_at < a.created_at) AS bought_before,
         count(*) FILTER (WHERE a.bucket IN ('preparing', 'packed', 'courier', 'delivered')) AS sold_n,
         sum(a.price) FILTER (WHERE a.bucket IN ('preparing', 'packed', 'courier', 'delivered')) AS sold_eur
  FROM ap8 a
  LEFT JOIN fo ON fo.p8 = a.p8 AND length(a.p8) = 8
  GROUP BY 2
  UNION ALL
  SELECT f.src, coalesce(f.sale_source_detail, 'unknown'), 'placed', f.sale_source, f.sale_source_detail,
         count(*), sum(f.price), NULL, NULL,
         count(*) FILTER (WHERE f.bucket IN ('preparing', 'packed', 'courier', 'delivered')),
         sum(f.price) FILTER (WHERE f.bucket IN ('preparing', 'packed', 'courier', 'delivered'))
  FROM f WHERE f.in_cur AND f.src IN ('elyon_crm', 'teleshop_other', 'web')
  GROUP BY f.src, f.sale_source, f.sale_source_detail
  UNION ALL
  SELECT m.src, CASE WHEN m.src = 'web' THEN 'mex_only' ELSE 'mex_only_unlinked' END, 'placed', NULL, NULL,
         count(*), NULL, sum(m.cod_mkd), NULL, NULL, NULL
  FROM mf m WHERE m.in_cur AND NOT m.claimed GROUP BY m.src
  UNION ALL
  SELECT 'web', 'shop', 'placed', NULL, NULL, w.placed_n, round(w.placed_mkd / 61.5, 2), w.placed_mkd, NULL, NULL, NULL
  FROM wsum w WHERE w.per = 'cur' AND w.present
),
spl_fixed AS (
  SELECT * FROM (VALUES
    ('altercpa', 'new', 1), ('altercpa', 'returning', 2),
    ('elyon_crm', 'prediction_list', 1), ('elyon_crm', 'direct', 2), ('elyon_crm', 'disposition', 3),
    ('teleshop_other', 'teleshop', 1), ('teleshop_other', 'social', 2), ('teleshop_other', 'leads', 3),
    ('teleshop_other', 'leads_out', 4), ('teleshop_other', 'mex_only_unlinked', 9),
    ('web', 'shop', 1), ('web', 'mex_only', 2)) v(src, k, ord)
),
splj AS MATERIALIZED (  -- read per source by a correlated sub-select: evaluate once
  SELECT x.src,
    jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
      'key', x.k, 'basis', 'placed',
      'count', x.n,
      'value_eur', CASE WHEN x.eur IS NOT NULL THEN round(x.eur, 2) END,
      'cod_mkd', CASE WHEN x.mkd IS NOT NULL THEN round(x.mkd) END,
      'bought_before', x.bought_before,
      'sold_count', x.sold_n,
      'sold_value_eur', CASE WHEN x.sold_n IS NOT NULL THEN round(coalesce(x.sold_eur, 0), 2) END,
      'drill', CASE
                 WHEN x.k IN ('mex_only', 'mex_only_unlinked', 'new', 'returning', 'shop') THEN NULL
                 WHEN x.src = 'elyon_crm' THEN jsonb_build_object('sale_source', jsonb_build_array('elyon_crm'), 'detail', jsonb_build_array(x.k))
                 WHEN x.sale_source IS NOT NULL THEN jsonb_build_object('sale_source', jsonb_build_array(x.sale_source), 'detail', jsonb_build_array(x.k))
                 WHEN x.src = 'teleshop_other' THEN jsonb_build_object('sale_source', jsonb_build_array('collabbox'), 'detail', jsonb_build_array(x.k))
               END))
      ORDER BY x.ord, x.n DESC, x.k) AS j
  FROM (
    SELECT coalesce(a.src, fx.src) AS src, coalesce(a.k, fx.k) AS k,
           coalesce(fx.ord, 5) AS ord,
           coalesce(a.n, 0) AS n,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked') THEN NULL ELSE coalesce(a.eur, 0) END AS eur,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked', 'shop') THEN coalesce(a.mkd, 0) END AS mkd,
           a.sale_source,
           CASE WHEN coalesce(a.k, fx.k) = 'returning' THEN coalesce(a.bought_before, 0) END AS bought_before,
           CASE WHEN coalesce(a.k, fx.k) IN ('mex_only', 'mex_only_unlinked', 'shop') THEN NULL
                ELSE coalesce(a.sold_n, 0) END AS sold_n,
           a.sold_eur
    FROM (SELECT src, k, max(sale_source) AS sale_source, sum(n) AS n, sum(eur) AS eur, sum(mkd) AS mkd,
                 sum(bought_before) AS bought_before, sum(sold_n) AS sold_n, sum(sold_eur) AS sold_eur
          FROM spl GROUP BY src, k) a
    FULL JOIN spl_fixed fx ON fx.src = a.src AND fx.k = a.k
  ) x
  GROUP BY x.src
),

-- ── sources ────────────────────────────────────────────────────────────────
src_json AS (
  SELECT s.ord, jsonb_build_object(
    'key', s.src,
    'placed', jsonb_build_object(
      'count', s.placed_n + CASE WHEN s.src = 'web' THEN (SELECT w.placed_n FROM wsum w WHERE w.per = 'cur') ELSE 0 END,
      'value_eur', round(s.placed_eur + CASE WHEN s.src = 'web' THEN (SELECT w.placed_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2)),
    'buckets',
      (SELECT j FROM sbj WHERE sbj.src = s.src)
      || CASE WHEN s.src IN ('teleshop_other', 'web')
              THEN jsonb_build_object('mex_only', jsonb_build_object('count', s.mo_coh_n, 'cod_mkd', round(s.mo_coh_mkd)))
              ELSE '{}'::jsonb END,
    'money', jsonb_build_object(
      'collected_mkd',          round(s.coll_mkd + CASE WHEN s.src = 'web' THEN (SELECT w.coll_mkd FROM wsum w WHERE w.per = 'cur') ELSE 0 END),
      'collected_proven_mkd',   round(s.coll_proven_mkd),
      'collected_unproven_mkd', round(s.coll_mkd - s.coll_proven_mkd),
      -- the web shop mirror's own "collected" (its panel's rule, not MEX):
      -- collected = proven + unproven + shop
      'collected_shop_mkd',     CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                                     THEN round((SELECT w.coll_mkd FROM wsum w WHERE w.per = 'cur')) END,
      'to_collect_eur',         round(s.tc_eur + CASE WHEN s.src = 'web' THEN (SELECT w.tc_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2),
      'lost_eur',               round(s.lost_eur + CASE WHEN s.src = 'web' THEN (SELECT w.lost_mkd FROM wsum w WHERE w.per = 'cur') / 61.5 ELSE 0 END, 2),
      'unrecorded_mkd',         CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                                     THEN round((SELECT w.unrec_mkd FROM wsum w WHERE w.per = 'cur')) END),
    'cash', jsonb_build_object(
      'count',            s.o_cash_n + s.mo_cash_n,
      'cod_mkd',          round(s.o_cash_mkd + s.mo_cash_mkd),
      'proven_count',     s.cash_proven_n + s.mo_cash_n,
      'proven_cod_mkd',   round(s.cash_proven_mkd + s.mo_cash_mkd),
      'unproven_count',   s.o_cash_n - s.cash_proven_n,
      'unproven_cod_mkd', round(s.o_cash_mkd - s.cash_proven_mkd),
      'mex_only_count',   s.mo_cash_n,
      'mex_only_cod_mkd', round(s.mo_cash_mkd)),
    'worked',      s.worked,
    'cohort_sold', s.cohort_sold,
    'conversion',  CASE WHEN s.worked > 0 THEN round(s.cohort_sold::numeric / s.worked, 4) END,
    'confirmed',   s.conf_n,
    'confirmed_value_eur', round(s.conf_eur, 2),
    'aov_eur',     CASE WHEN s.conf_n > 0 THEN round(s.conf_eur / s.conf_n, 2) END,
    'splits',      coalesce((SELECT j FROM splj WHERE splj.src = s.src), '[]'::jsonb),
    'drill', CASE s.src
               WHEN 'altercpa'       THEN jsonb_build_object('sale_source', jsonb_build_array('altercpa', 'affiliate'))
               WHEN 'elyon_crm'      THEN jsonb_build_object('sale_source', jsonb_build_array('elyon_crm'))
               WHEN 'web'            THEN jsonb_build_object('sale_source', jsonb_build_array('web'))
               ELSE                       jsonb_build_object('sale_source', jsonb_build_array('collabbox', 'legacy'))
             END,
    'web_block', CASE WHEN s.src = 'web' THEN (SELECT present FROM wsum WHERE per = 'cur') END,
    -- the shop mirror's part of placed (verify-attribution C1 ties the rest
    -- to SQL over public.orders; C14 checks this part against web_orders)
    'placed_shop', CASE WHEN s.src = 'web' AND (SELECT present FROM wsum WHERE per = 'cur')
                        THEN (SELECT jsonb_build_object('count', w.placed_n, 'value_eur', round(w.placed_mkd / 61.5, 2),
                                                        'value_mkd', round(w.placed_mkd))
                              FROM wsum w WHERE w.per = 'cur') END
  ) AS j
  FROM s
),

-- ── KPI tiles = Σ sources, on each tile's own clock ────────────────────────
kp AS (
  SELECT
    sum(s.placed_n) AS placed_n, sum(s.placed_eur) AS placed_eur,
    sum(s.p_placed_n) AS p_placed_n, sum(s.p_placed_eur) AS p_placed_eur,
    sum(s.conf_n) AS conf_n, sum(s.conf_eur) AS conf_eur, sum(s.p_conf_n) AS p_conf_n, sum(s.p_conf_eur) AS p_conf_eur,
    sum(s.cour_n) AS cour_n, sum(s.cour_eur) AS cour_eur, sum(s.cour_mkd) AS cour_mkd,
    sum(s.p_cour_n) AS p_cour_n, sum(s.p_cour_eur) AS p_cour_eur, sum(s.p_cour_mkd) AS p_cour_mkd,
    sum(s.tc_n) AS tc_n, sum(s.tc_eur) AS tc_eur, sum(s.p_tc_n) AS p_tc_n, sum(s.p_tc_eur) AS p_tc_eur,
    sum(s.lost_n) AS lost_n, sum(s.lost_eur) AS lost_eur, sum(s.p_lost_n) AS p_lost_n, sum(s.p_lost_eur) AS p_lost_eur,
    sum(s.o_cash_n) AS o_cash_n, sum(s.o_cash_mkd) AS o_cash_mkd,
    sum(s.cash_proven_n) AS cash_proven_n, sum(s.cash_proven_mkd) AS cash_proven_mkd, sum(s.unproven_eur) AS unproven_eur,
    sum(s.mo_cash_n) AS mo_cash_n, sum(s.mo_cash_mkd) AS mo_cash_mkd,
    sum(s.p_o_cash_n) AS p_o_cash_n, sum(s.p_o_cash_mkd) AS p_o_cash_mkd,
    sum(s.p_cash_proven_n) AS p_cash_proven_n, sum(s.p_cash_proven_mkd) AS p_cash_proven_mkd, sum(s.p_unproven_eur) AS p_unproven_eur,
    sum(s.p_mo_cash_n) AS p_mo_cash_n, sum(s.p_mo_cash_mkd) AS p_mo_cash_mkd
  FROM s
),
wk_b AS (   -- the web block's own contribution to the cohort tiles
  SELECT w.per, w.present, w.placed_n, w.placed_mkd, w.tc_mkd, w.lost_mkd,
         coalesce((SELECT b.n   FROM wbk b WHERE b.per = w.per AND b.bucket = 'courier'), 0) AS cour_n,
         coalesce((SELECT b.mkd FROM wbk b WHERE b.per = w.per AND b.bucket = 'courier'), 0) AS cour_mkd,
         coalesce((SELECT sum(b.n) FROM wbk b WHERE b.per = w.per AND b.bucket IN ('preparing', 'courier')), 0) AS tc_n,
         coalesce((SELECT sum(b.n) FROM wbk b WHERE b.per = w.per AND b.bucket IN ('returned', 'cancelled')), 0) AS lost_n
  FROM wsum w
),
kpj AS (
  SELECT jsonb_build_object(
    'placed',     jsonb_build_object('count', k.placed_n + c.placed_n,
                                     'value_eur', round(k.placed_eur + c.placed_mkd / 61.5, 2)),
    'confirmed',  jsonb_build_object('count', k.conf_n, 'value_eur', round(k.conf_eur, 2)),
    'at_courier', jsonb_build_object('count', k.cour_n + c.cour_n,
                                     'value_eur', round(k.cour_eur + c.cour_mkd / 61.5, 2),
                                     'cod_mkd', round(k.cour_mkd + c.cour_mkd)),
    'delivered',  jsonb_build_object('count', k.o_cash_n + k.mo_cash_n,
                                     'cod_mkd', round(k.o_cash_mkd + k.mo_cash_mkd),
                                     'proven_count', k.cash_proven_n + k.mo_cash_n,
                                     'proven_cod_mkd', round(k.cash_proven_mkd + k.mo_cash_mkd),
                                     'unproven_count', k.o_cash_n - k.cash_proven_n,
                                     'unproven_cod_mkd', round(k.o_cash_mkd - k.cash_proven_mkd),
                                     'mex_only_count', k.mo_cash_n,
                                     'mex_only_cod_mkd', round(k.mo_cash_mkd)),
    'to_collect', jsonb_build_object('count', k.tc_n + c.tc_n,
                                     'value_eur', round(k.tc_eur + c.tc_mkd / 61.5, 2)),
    'lost',       jsonb_build_object('count', k.lost_n + c.lost_n,
                                     'value_eur', round(k.lost_eur + c.lost_mkd / 61.5, 2)),
    'unproven_paid', jsonb_build_object('count', k.o_cash_n - k.cash_proven_n,
                                        'value_eur', round(k.unproven_eur, 2),
                                        'cod_mkd', round(k.o_cash_mkd - k.cash_proven_mkd)),
    'prev', CASE WHEN (SELECT pf FROM win) IS NULL THEN NULL ELSE jsonb_build_object(
      'placed',     jsonb_build_object('count', k.p_placed_n + p.placed_n,
                                       'value_eur', round(k.p_placed_eur + p.placed_mkd / 61.5, 2)),
      'confirmed',  jsonb_build_object('count', k.p_conf_n, 'value_eur', round(k.p_conf_eur, 2)),
      'at_courier', jsonb_build_object('count', k.p_cour_n + p.cour_n,
                                       'value_eur', round(k.p_cour_eur + p.cour_mkd / 61.5, 2),
                                       'cod_mkd', round(k.p_cour_mkd + p.cour_mkd)),
      'delivered',  jsonb_build_object('count', k.p_o_cash_n + k.p_mo_cash_n,
                                       'cod_mkd', round(k.p_o_cash_mkd + k.p_mo_cash_mkd),
                                       'proven_count', k.p_cash_proven_n + k.p_mo_cash_n,
                                       'proven_cod_mkd', round(k.p_cash_proven_mkd + k.p_mo_cash_mkd),
                                       'unproven_count', k.p_o_cash_n - k.p_cash_proven_n,
                                       'unproven_cod_mkd', round(k.p_o_cash_mkd - k.p_cash_proven_mkd),
                                       'mex_only_count', k.p_mo_cash_n,
                                       'mex_only_cod_mkd', round(k.p_mo_cash_mkd)),
      'to_collect', jsonb_build_object('count', k.p_tc_n + p.tc_n,
                                       'value_eur', round(k.p_tc_eur + p.tc_mkd / 61.5, 2)),
      'lost',       jsonb_build_object('count', k.p_lost_n + p.lost_n,
                                       'value_eur', round(k.p_lost_eur + p.lost_mkd / 61.5, 2)),
      'unproven_paid', jsonb_build_object('count', k.p_o_cash_n - k.p_cash_proven_n,
                                          'value_eur', round(k.p_unproven_eur, 2),
                                          'cod_mkd', round(k.p_o_cash_mkd - k.p_cash_proven_mkd))) END
  ) AS j
  FROM kp k
  CROSS JOIN (SELECT * FROM wk_b WHERE per = 'cur') c
  CROSS JOIN (SELECT * FROM wk_b WHERE per = 'prev') p
),

-- ── per Skopje day × source over the spark window (which contains the
-- current one): trend and spark both roll up from these few hundred rows.
dpl AS (   -- PLACED clock
  SELECT f.cday AS day, f.src, count(*) AS n, sum(f.price) AS eur
  FROM f WHERE f.in_spark GROUP BY 1, 2
  UNION ALL
  SELECT wd.d::date, 'web', sum(wd.n), sum(wd.mkd) / 61.5
  FROM wday wd, win w WHERE wd.d::date BETWEEN w.sfd AND w.td GROUP BY 1
),
dca AS (   -- CASH clock
  SELECT f.kday AS day, f.src, count(*) AS n, sum(f.cash_mkd) AS mkd
  FROM f WHERE f.cash_spark GROUP BY 1, 2
  UNION ALL
  SELECT m.kday, m.src, count(*), sum(m.cod_mkd)
  FROM mf m WHERE m.cash_spark GROUP BY 1, 2
),

-- ── spark: ≥ 14 days, daily (monthly past 62 days) ─────────────────────────
spk_keys AS (
  SELECT to_char(g, w.sfmt) AS b
  FROM win w, generate_series(date_trunc(w.sgran, w.sfd::timestamp), date_trunc(w.sgran, w.td::timestamp),
                              ('1 ' || w.sgran)::interval) g
),
spk_p AS (
  SELECT to_char(date_trunc(w.sgran, x.day::timestamp), w.sfmt) AS b, sum(x.eur) AS eur
  FROM dpl x, win w WHERE x.day BETWEEN w.sfd AND w.td GROUP BY 1
),
spk_d AS (
  SELECT to_char(date_trunc(w.sgran, x.day::timestamp), w.sfmt) AS b, sum(x.mkd) AS mkd
  FROM dca x, win w WHERE x.day BETWEEN w.sfd AND w.td GROUP BY 1
),
spkj AS (
  SELECT jsonb_build_object(
    'from', (SELECT to_char(sfd, 'YYYY-MM-DD') FROM win),
    'granularity', (SELECT sgran FROM win),
    'placed_value', (SELECT jsonb_agg(jsonb_build_object('d', k.b, 'v', round(coalesce(p.eur, 0), 2)) ORDER BY k.b)
                     FROM spk_keys k LEFT JOIN (SELECT b, sum(eur) AS eur FROM spk_p GROUP BY b) p ON p.b = k.b),
    'delivered_cash_mkd', (SELECT jsonb_agg(jsonb_build_object('d', k.b, 'v', round(coalesce(x.mkd, 0))) ORDER BY k.b)
                           FROM spk_keys k LEFT JOIN (SELECT b, sum(mkd) AS mkd FROM spk_d GROUP BY b) x ON x.b = k.b)
  ) AS j
),

-- ── trend: one point per day (per month past 62 days), every source ────────
tr_keys AS (
  SELECT to_char(g, w.fmt) AS b
  FROM win w, generate_series(date_trunc(w.gran, w.fd::timestamp), date_trunc(w.gran, w.td::timestamp),
                              ('1 ' || w.gran)::interval) g
),
tr_p AS (
  SELECT to_char(date_trunc(w.gran, x.day::timestamp), w.fmt) AS b, x.src, sum(x.n) AS n, sum(x.eur) AS eur
  FROM dpl x, win w WHERE x.day BETWEEN w.fd AND w.td GROUP BY 1, 2
),
tr_d AS (
  SELECT to_char(date_trunc(w.gran, x.day::timestamp), w.fmt) AS b, x.src, sum(x.n) AS n, sum(x.mkd) AS mkd
  FROM dca x, win w WHERE x.day BETWEEN w.fd AND w.td GROUP BY 1, 2
),
trj AS (
  SELECT jsonb_build_object(
    'granularity', (SELECT gran FROM win),
    'points', coalesce(jsonb_agg(pt.j ORDER BY pt.b), '[]'::jsonb)) AS j
  FROM (
    SELECT k.b, jsonb_build_object('bucket', k.b, 'by_source', jsonb_object_agg(sr.src, jsonb_build_object(
             'placed_count',       coalesce(p.n, 0),
             'placed_value_eur',   round(coalesce(p.eur, 0), 2),
             'delivered_count',    coalesce(x.n, 0),
             'delivered_cash_mkd', round(coalesce(x.mkd, 0))) ORDER BY sr.ord)) AS j
    FROM tr_keys k CROSS JOIN srcs sr
    LEFT JOIN tr_p p ON p.b = k.b AND p.src = sr.src
    LEFT JOIN tr_d x ON x.b = k.b AND x.src = sr.src
    GROUP BY k.b
  ) pt
),

-- ── teams: roster × work ledger × sales × presence ─────────────────────────
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.via, v.order_id, v.decision, v.outcome, v.actor_ext
  FROM public.v_sales_work v, win w
  WHERE v.at BETWEEN w.f AND w.t
    -- a decision on a test-phone order is no work (the order is in no report)
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
mem AS (
  SELECT DISTINCT ON (m.team_key, m.person_id)
         m.team_key, m.person_id, sp.display_name, sp.user_id, sp.is_manager, m.role AS team_role
  FROM public.sales_team_members m
  JOIN public.sales_people sp ON sp.id = m.person_id
  CROSS JOIN win w
  WHERE m.valid_from <= w.td AND coalesce(m.valid_to, 'infinity'::date) >= w.fd
  ORDER BY m.team_key, m.person_id, m.is_primary DESC, m.valid_from DESC
),
wk AS (
  SELECT vw.person_id, count(*) AS worked, count(*) FILTER (WHERE vw.outcome = 'sale') AS sales, max(vw.at) AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),
ps AS (
  SELECT f.sold_by_person_id AS person_id,
         count(*) FILTER (WHERE f.sale_cur)                       AS confirmed,
         coalesce(sum(f.price) FILTER (WHERE f.sale_cur), 0)      AS sold_eur,
         count(*) FILTER (WHERE f.cash_cur)                       AS cash_n,
         coalesce(sum(f.cash_mkd) FILTER (WHERE f.cash_cur), 0)   AS cash_mkd
  FROM f WHERE f.sold_by_person_id IS NOT NULL GROUP BY 1
),
pr AS (
  SELECT a.user_id,
         sum(a.online_minutes) AS online_min, sum(a.active_minutes) AS active_min,
         sum(a.idle_minutes) AS idle_min, sum(a.break_minutes) AS break_min,
         min(a.first_active_at) AS first_active, max(a.last_active_at) AS last_active,
         sum(a.idle_alerts) AS idle_alerts
  FROM public.agent_presence_days a, win w
  WHERE a.day BETWEEN w.fd AND w.td
  GROUP BY 1
),
pn AS (
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
una AS (
  SELECT 'unassigned'::text AS team_key, sp.id AS person_id, sp.display_name, sp.user_id, sp.is_manager, 'member'::text AS team_role
  FROM public.sales_people sp
  WHERE (EXISTS (SELECT 1 FROM wk WHERE wk.person_id = sp.id)
         OR EXISTS (SELECT 1 FROM ps WHERE ps.person_id = sp.id AND (ps.confirmed > 0 OR ps.cash_n > 0)))
    AND NOT EXISTS (SELECT 1 FROM mem WHERE mem.person_id = sp.id)
),
tm AS (
  SELECT r.team_key, r.person_id, r.display_name, r.user_id, r.is_manager, r.team_role,
         CASE WHEN r.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END AS online_state,
         pr.online_min, pr.active_min, pr.idle_min, pr.break_min, pr.first_active, pr.last_active, pr.idle_alerts,
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sales, 0) AS sales, wk.last_at,
         coalesce(ps.confirmed, 0) AS confirmed, coalesce(ps.sold_eur, 0) AS sold_eur,
         coalesce(ps.cash_mkd, 0) AS cash_mkd
  FROM (SELECT * FROM mem UNION ALL SELECT * FROM una) r
  LEFT JOIN pn ON pn.user_id = r.user_id
  LEFT JOIN pr ON pr.user_id = r.user_id
  LEFT JOIN wk ON wk.person_id = r.person_id
  LEFT JOIN ps ON ps.person_id = r.person_id
),
teamj AS (
  SELECT coalesce(jsonb_agg(t.j ORDER BY t.ord, t.name), '[]'::jsonb) AS j
  FROM (
    SELECT tk.team_key,
           coalesce(st.name, 'Unassigned') AS name,
           CASE tk.team_key WHEN 'altercpa_leads' THEN 1 WHEN 'crm_prediction' THEN 2
                            WHEN 'management' THEN 3 WHEN 'unassigned' THEN 9 ELSE 5 END AS ord,
           jsonb_build_object(
             'team_key',  tk.team_key,
             'name',      coalesce(st.name, 'Unassigned'),
             'mode',      st.leaderboard_mode,
             'online_now', count(*) FILTER (WHERE tm.online_state IN ('online', 'idle')),
             'break_now',  count(*) FILTER (WHERE tm.online_state = 'break'),
             'worked',     coalesce(sum(tm.worked), 0),
             'confirmed',  coalesce(sum(tm.confirmed), 0),
             'sold_value_eur', round(coalesce(sum(tm.sold_eur), 0), 2),
             'delivered_cash_mkd', round(coalesce(sum(tm.cash_mkd), 0)),
             'unmapped_decisions', CASE WHEN tk.team_key = 'unassigned'
                                        THEN (SELECT count(*) FROM vw WHERE vw.person_id IS NULL) END
           ) || jsonb_build_object('members', coalesce(jsonb_agg(jsonb_build_object(
             'person_id',   tm.person_id,
             'name',        tm.display_name,
             'user_id',     tm.user_id,
             'is_manager',  tm.is_manager,
             'role',        tm.team_role,
             'online_state', tm.online_state,
             'online_min',  tm.online_min,
             'active_min',  tm.active_min,
             'idle_min',    tm.idle_min,
             'break_min',   tm.break_min,
             'first_active', tm.first_active,
             'last_active', tm.last_active,
             'idle_alerts', tm.idle_alerts,
             'worked',      tm.worked,
             'sales_decisions', tm.sales,
             'confirmed',   tm.confirmed,
             'conversion',  CASE WHEN tm.worked > 0 THEN round(tm.sales::numeric / tm.worked, 4) END,
             'sold_value_eur', round(tm.sold_eur, 2),
             'delivered_cash_mkd', round(tm.cash_mkd),
             'last_decision_at', tm.last_at)
             ORDER BY tm.sold_eur DESC, tm.worked DESC, tm.display_name) FILTER (WHERE tm.person_id IS NOT NULL), '[]'::jsonb)) AS j
    FROM (SELECT DISTINCT team_key FROM tm
          UNION SELECT key FROM public.sales_teams
          UNION SELECT 'unassigned' WHERE EXISTS (SELECT 1 FROM vw WHERE vw.person_id IS NULL)) tk
    LEFT JOIN public.sales_teams st ON st.key = tk.team_key
    LEFT JOIN tm ON tm.team_key = tk.team_key
    GROUP BY tk.team_key, st.name, st.leaderboard_mode
  ) t
),

-- ── freshness ──────────────────────────────────────────────────────────────
fr_acpa AS (
  SELECT (SELECT max(r.finished_at) FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.finished_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'rolling' AND r2.status = 'ok'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active)                                                        AS last_ok,
         (SELECT r.status FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.status, r2.started_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'rolling'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active ORDER BY r.started_at DESC LIMIT 1)                     AS last_status,
         (SELECT max(r.finished_at) FROM public.altercpa_accounts a
            CROSS JOIN LATERAL (SELECT r2.finished_at FROM public.altercpa_sync_runs r2
                                 WHERE r2.account_id = a.id AND r2.kind = 'status' AND r2.status = 'ok'
                                 ORDER BY r2.started_at DESC LIMIT 1) r
           WHERE a.is_active)                                                        AS status_ok
),
fr_mex_runs AS (
  SELECT r.started_at, r.finished_at, r.status, r.skipped
  FROM public.mex_sync_runs r
  WHERE r.started_at > now() - interval '10 days'
),
fr_mex AS (
  SELECT a.acct,
         coalesce((SELECT max(r.finished_at) FROM fr_mex_runs r
                    WHERE r.status = 'ok' AND r.skipped ? ('fetched_' || a.acct)),
                  (SELECT max(p.last_seen_at) FROM public.mex_parcels p WHERE p.account = a.acct)) AS last_ok,
         (SELECT r.status FROM fr_mex_runs r ORDER BY r.started_at DESC LIMIT 1)                   AS last_status,
         (SELECT max(p.last_update_at) FROM public.mex_parcels p WHERE p.account = a.acct)         AS data_through
  FROM (VALUES ('bio_natural'), ('natura')) a(acct)
),
-- mex-reconcile runs every 30 min inside 07:00–20:55 Skopje only, so outside
-- that window "fresh" means "the last run of the working day happened".
fr_mex_expect AS (
  SELECT CASE WHEN l::time BETWEEN time '07:45' AND time '21:00' THEN now()
              WHEN l::time < time '07:45' THEN ((l::date - 1) + time '20:40') AT TIME ZONE 'Europe/Skopje'
              ELSE (l::date + time '20:40') AT TIME ZONE 'Europe/Skopje' END AS expected
  FROM (SELECT now() AT TIME ZONE 'Europe/Skopje' AS l) z
),
fr_cb AS (
  SELECT max(x.created_at) AS last_doc
  FROM public.orders x WHERE x.sale_source = 'collabbox'
),
frj AS (
  SELECT jsonb_build_array(
    (SELECT jsonb_build_object(
       'feed', 'altercpa', 'last_ok_at', a.last_ok,
       'status', CASE WHEN a.last_ok IS NULL THEN 'failed'
                      WHEN a.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN a.last_ok < now() - interval '15 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'rolling every 2 min; status sync last ok ' || coalesce(to_char(a.status_ok AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', a.last_status,
       'status_sync_ok_at', a.status_ok)
     FROM fr_acpa a),
    (SELECT jsonb_build_object(
       'feed', 'mex_bio_natural', 'last_ok_at', m.last_ok,
       'status', CASE WHEN m.last_ok IS NULL THEN 'failed'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN m.last_ok < e.expected - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'mex-reconcile every 30 min 07:00-20:55; parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', m.last_status,
       'data_through', m.data_through)
     FROM fr_mex m, fr_mex_expect e WHERE m.acct = 'bio_natural'),
    (SELECT jsonb_build_object(
       'feed', 'mex_natura', 'last_ok_at', m.last_ok,
       'status', CASE WHEN m.last_ok IS NULL THEN 'failed'
                      WHEN m.last_status IS DISTINCT FROM 'ok' THEN 'failed'
                      WHEN m.last_ok < e.expected - interval '45 minutes' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'mex-reconcile every 30 min 07:00-20:55; parcels updated through ' || coalesce(to_char(m.data_through AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI'), '-'),
       'last_run_status', m.last_status,
       'data_through', m.data_through)
     FROM fr_mex m, fr_mex_expect e WHERE m.acct = 'natura'),
    CASE
      WHEN $7::jsonb IS NULL THEN jsonb_build_object(
        'feed', 'web', 'last_ok_at', NULL, 'status', 'n/a',
        'detail', coalesce('web block error: ' || $8::text, 'web-sync not deployed yet'))
      WHEN $7::jsonb ? 'error' THEN jsonb_build_object(
        'feed', 'web', 'last_ok_at', NULL, 'status', 'failed',
        'detail', 'web_sync_runs unreadable: ' || ($7::jsonb ->> 'error'))
      ELSE jsonb_build_object(
        'feed', 'web', 'last_ok_at', $7::jsonb -> 'last_ok_at',
        'status', CASE WHEN $7::jsonb ->> 'last_ok_at' IS NULL THEN 'failed'
                       WHEN ($7::jsonb ->> 'last_status') = 'failed' THEN 'failed'
                       WHEN ($7::jsonb ->> 'last_ok_at')::timestamptz < now() - interval '45 minutes' THEN 'stale'
                       ELSE 'ok' END,
        'detail', coalesce('last error: ' || ($7::jsonb ->> 'last_error'), 'web-sync every 15 min')
                  || CASE WHEN $8::text IS NOT NULL THEN '; web block error: ' || $8::text ELSE '' END,
        'last_run_status', $7::jsonb -> 'last_status')
    END,
    (SELECT jsonb_build_object(
       'feed', 'collabbox', 'last_ok_at', c.last_doc,
       'status', CASE WHEN c.last_doc IS NULL THEN 'n/a'
                      WHEN c.last_doc < now() - interval '7 days' THEN 'stale'
                      ELSE 'ok' END,
       'detail', 'manual import; newest document ' || coalesce(to_char(c.last_doc AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY'), '-'),
       'data_through', c.last_doc)
     FROM fr_cb c)
  ) AS j
),

-- ── attention ──────────────────────────────────────────────────────────────
pname AS (SELECT sp.id, sp.display_name FROM public.sales_people sp),
-- anp and mp are "state as of now" and are written so that GET /orders
-- ?attention=approved_no_parcel_7d|mex_problem (overview.ts attentionFilter)
-- lists exactly these orders — change the two together.
anp AS (   -- AlterCPA sale, still no parcel N days after the sale ($13 =
           -- app_settings.no_parcel_rule.days, default 10), not postponed
  SELECT x.id, x.display_id, coalesce(x.price, 0) AS price,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS sold_at, x.sold_by_person_id
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source IN ('altercpa', 'affiliate')
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at) < now() - make_interval(days => $13::int)
    AND x.mex_tracking_id IS NULL
    AND (x.ship_after_date IS NULL OR x.ship_after_date <= (now() AT TIME ZONE 'Europe/Skopje')::date)
    AND x.id NOT IN (SELECT xto.id FROM xto)
),
mp AS (    -- the order's own parcel is Problematic / Delivery attempted / Rejected
  SELECT p.tracking_id, p.status_id, p.status_name, p.cod_mkd, p.last_update_at,
         x.display_id, coalesce(x.price, 0) AS price, x.sold_by_person_id
  FROM public.mex_parcels p JOIN public.orders x ON x.mex_tracking_id = p.tracking_id
  WHERE p.status_id IN (3, 9, 13) AND x.mex_status_id IN (3, 9, 13)
    AND x.id NOT IN (SELECT xto.id FROM xto)
),
cm AS (    -- COD ≠ price: delivered or returned in the window, not exact, not +150
  SELECT o.display_id, o.price, o.mex_cod_mkd, o.sold_by_person_id,
         o.mex_cod_mkd - round(o.price * 61.5) AS diff,
         coalesce(o.mex_delivered_at, o.mex_returned_at) AS at
  FROM f o, win w
  WHERE o.mex_cod_mkd IS NOT NULL
    AND ((o.bucket = 'delivered' AND o.mex_delivered_at BETWEEN w.f AND w.t)
         OR (o.bucket = 'returned' AND o.mex_returned_at BETWEEN w.f AND w.t))
    AND abs(o.mex_cod_mkd - round(o.price * 61.5)) > 3
    AND abs(o.mex_cod_mkd - round(o.price * 61.5) - 150) > 3
),
ul AS (    -- delivered in the window, no order, not the web shop's
  SELECT m.tracking_id, m.account, m.series, m.cod_mkd, m.delivered_at
  FROM mf m WHERE m.cash_cur AND m.src = 'teleshop_other'
),
na AS (    -- AlterCPA approvals 23:00–05:59 Skopje
  SELECT vw.person_id, vw.actor_ext, vw.order_id, vw.at
  FROM vw
  WHERE vw.via = 'altercpa' AND vw.decision = 'approved'
    AND extract(hour FROM vw.at AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 6 AND 22
),
ap AS (    -- AlterCPA approvals in the window, per operator
  SELECT coalesce(vw.person_id::text, 'ext:' || coalesce(vw.actor_ext, '?')) AS op,
         vw.person_id, vw.actor_ext, vw.order_id, vw.at
  FROM vw WHERE vw.via = 'altercpa' AND vw.decision = 'approved'
),
apw AS (
  SELECT ap.*, count(*) OVER (PARTITION BY ap.op ORDER BY ap.at
                              RANGE BETWEEN CURRENT ROW AND interval '10 minutes' FOLLOWING) AS fwd
  FROM ap
),
-- An approval is in a burst when some burst START (≥ 8 approvals in the 10
-- minutes from it) lies in the 10 minutes before it — two window passes, no
-- self-join.
apm AS (
  SELECT apw.*,
         max(CASE WHEN apw.fwd >= 8 THEN apw.at END)
           OVER (PARTITION BY apw.op ORDER BY apw.at
                 RANGE BETWEEN interval '10 minutes' PRECEDING AND CURRENT ROW) AS burst_start
  FROM apw
),
bmem AS (
  SELECT apm.op, apm.person_id, apm.actor_ext, apm.order_id, apm.at
  FROM apm WHERE apm.burst_start IS NOT NULL
),
bclu AS (  -- burst windows merged per operator, for the sample
  SELECT op, min(at) AS s, max(at) AS e, count(*) AS n, max(person_id::text) AS person_id, max(actor_ext) AS actor_ext
  FROM (SELECT bm.*, sum(CASE WHEN bm.at > lag_at + interval '10 minutes' OR lag_at IS NULL THEN 1 ELSE 0 END)
                       OVER (PARTITION BY bm.op ORDER BY bm.at) AS grp
        FROM (SELECT bmem.*, lag(bmem.at) OVER (PARTITION BY bmem.op ORDER BY bmem.at) AS lag_at FROM bmem) bm) z
  GROUP BY op, grp
),
att AS (
  SELECT 1 AS ord, jsonb_build_object(
    'kind', 'approved_no_parcel_7d',
    'days', $13::int,
    'severity', CASE WHEN count(*) >= 10 THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'value_eur', round(sum(a.price), 2),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT a2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM anp a2 LEFT JOIN pname pn2 ON pn2.id = a2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id,
                        'at', q.sold_at,
                        'days', q.days,
                        'person', q.nm,
                        'note', coalesce(q.nm, 'Unknown') || ' · ' || to_char(q.sold_at AT TIME ZONE 'Europe/Skopje', 'DD.MM') || ' · ' || q.days || 'd') ORDER BY q.sold_at)
               FROM (SELECT a3.display_id, a3.sold_at, pn3.display_name AS nm,
                            (now()::date - a3.sold_at::date) AS days
                     FROM anp a3 LEFT JOIN pname pn3 ON pn3.id = a3.sold_by_person_id
                     ORDER BY a3.sold_at LIMIT 10) q)) AS j
  FROM anp a HAVING count(*) > 0
  UNION ALL
  SELECT 2, jsonb_build_object(
    'kind', 'mex_problem',
    'severity', CASE WHEN count(*) >= 20 THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'value_eur', round(sum(m.price), 2),
    'cod_mkd', sum(m.cod_mkd),
    'by_status', (SELECT jsonb_agg(jsonb_build_object('status_id', q.status_id, 'status_name', q.status_name, 'count', q.n) ORDER BY q.n DESC)
                  FROM (SELECT status_id, max(status_name) AS status_name, count(*) AS n FROM mp GROUP BY 1) q),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT m2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM mp m2 LEFT JOIN pname pn2 ON pn2.id = m2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'tracking_id', q.tracking_id, 'at', q.last_update_at,
                        'note', q.status_name || ' · ' || to_char(q.last_update_at AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI')) ORDER BY q.last_update_at DESC)
               FROM (SELECT * FROM mp ORDER BY last_update_at DESC NULLS LAST LIMIT 10) q)) AS j
  FROM mp m HAVING count(*) > 0
  UNION ALL
  SELECT 3, jsonb_build_object(
    'kind', 'cod_mismatch',
    'severity', 'warning',
    'count', count(*),
    'value_eur', round(sum(c.price), 2),
    'cod_mkd', sum(c.mex_cod_mkd),
    'diff_mkd', sum(c.diff),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT c2.sold_by_person_id AS pid, coalesce(pn2.display_name, 'Unknown') AS nm, count(*) AS n
                        FROM cm c2 LEFT JOIN pname pn2 ON pn2.id = c2.sold_by_person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'at', q.at,
                        'cod_mkd', q.mex_cod_mkd, 'price_mkd', round(q.price * 61.5), 'diff_mkd', q.diff,
                        'note', CASE WHEN q.price = 0 THEN 'price 0' ELSE 'COD <> price' END) ORDER BY abs(q.diff) DESC)
               FROM (SELECT * FROM cm ORDER BY abs(diff) DESC LIMIT 10) q)) AS j
  FROM cm c HAVING count(*) > 0
  UNION ALL
  SELECT 4, jsonb_build_object(
    'kind', 'unlinked_parcels',
    'severity', 'warning',
    'count', count(*),
    'cod_mkd', sum(u.cod_mkd),
    'value_eur', round(sum(u.cod_mkd) / 61.5, 2),
    'by_account', (SELECT jsonb_agg(jsonb_build_object('account', q.account, 'series', q.series, 'count', q.n, 'cod_mkd', q.mkd) ORDER BY q.n DESC)
                   FROM (SELECT account, coalesce(series, '-') AS series, count(*) AS n, sum(cod_mkd) AS mkd FROM ul GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.tracking_id, 'at', q.delivered_at, 'cod_mkd', q.cod_mkd,
                        'note', q.account || ' · ' || coalesce(q.series, '-') || ' · ' || to_char(q.delivered_at AT TIME ZONE 'Europe/Skopje', 'DD.MM')) ORDER BY q.delivered_at DESC)
               FROM (SELECT * FROM ul ORDER BY delivered_at DESC LIMIT 10) q)) AS j
  FROM ul u HAVING count(*) > 0
  UNION ALL
  SELECT 5, jsonb_build_object(
    'kind', 'stale_feed',
    'severity', CASE WHEN bool_or(e ->> 'status' = 'failed') THEN 'critical' ELSE 'warning' END,
    'count', count(*),
    'sample', jsonb_agg(jsonb_build_object('display_id', e ->> 'feed', 'at', e -> 'last_ok_at',
                                           'note', (e ->> 'status') || ' · ' || coalesce(e ->> 'detail', '')))) AS j
  FROM frj, jsonb_array_elements(frj.j) e
  WHERE e ->> 'status' IN ('stale', 'failed')
  HAVING count(*) > 0
  UNION ALL
  SELECT 6, jsonb_build_object(
    'kind', 'web_waiting_24h',
    'severity', CASE WHEN public.overview_jnum($11::jsonb -> 'count') >= 10 THEN 'critical' ELSE 'warning' END,
    'count', public.overview_jnum($11::jsonb -> 'count'),
    'value_eur', round(coalesce(public.overview_jnum($11::jsonb -> 'value_mkd'), 0) / 61.5, 2),
    'cod_mkd', round(coalesce(public.overview_jnum($11::jsonb -> 'value_mkd'), 0)),
    'sample', jsonb_build_array(jsonb_build_object('display_id', NULL, 'at', $11::jsonb -> 'oldest_at',
                                                   'note', 'oldest waiting web order'))) AS j
  WHERE coalesce(public.overview_jnum($11::jsonb -> 'count'), 0) > 0
  UNION ALL
  SELECT 7, jsonb_build_object(
    'kind', 'night_approvals',
    'severity', 'warning',
    'count', count(*),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT n2.person_id AS pid, coalesce(pn2.display_name, 'AlterCPA #' || coalesce(n2.actor_ext, '?')) AS nm, count(*) AS n
                        FROM na n2 LEFT JOIN pname pn2 ON pn2.id = n2.person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', q.display_id, 'at', q.at, 'person', q.nm,
                        'note', coalesce(q.nm, '?') || ' · ' || to_char(q.at AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI')) ORDER BY q.at DESC)
               FROM (SELECT x.display_id, n3.at, coalesce(pn3.display_name, 'AlterCPA #' || coalesce(n3.actor_ext, '?')) AS nm
                     FROM na n3 LEFT JOIN public.orders x ON x.id = n3.order_id
                     LEFT JOIN pname pn3 ON pn3.id = n3.person_id
                     ORDER BY n3.at DESC LIMIT 10) q)) AS j
  FROM na HAVING count(*) > 0
  UNION ALL
  SELECT 8, jsonb_build_object(
    'kind', 'burst_approvals',
    'severity', 'warning',
    'count', count(*),
    'windows', (SELECT count(*) FROM bclu),
    'by_person', (SELECT jsonb_agg(jsonb_build_object('person_id', q.pid, 'name', q.nm, 'count', q.n) ORDER BY q.n DESC, q.nm)
                  FROM (SELECT b2.person_id AS pid, coalesce(pn2.display_name, 'AlterCPA #' || coalesce(b2.actor_ext, '?')) AS nm, count(*) AS n
                        FROM bmem b2 LEFT JOIN pname pn2 ON pn2.id = b2.person_id GROUP BY 1, 2) q),
    'sample', (SELECT jsonb_agg(jsonb_build_object(
                        'display_id', NULL, 'at', q.s, 'person', q.nm, 'count', q.n,
                        'note', q.nm || ' · ' || to_char(q.s AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI') || '-'
                                || to_char(q.e AT TIME ZONE 'Europe/Skopje', 'HH24:MI') || ' · ' || q.n) ORDER BY q.s DESC)
               FROM (SELECT c.s, c.e, c.n, coalesce(pn3.display_name, 'AlterCPA #' || coalesce(c.actor_ext, '?')) AS nm
                     FROM bclu c LEFT JOIN pname pn3 ON pn3.id::text = c.person_id
                     ORDER BY c.s DESC LIMIT 10) q)) AS j
  FROM bmem HAVING count(*) > 0
),
attj AS (
  SELECT coalesce(jsonb_agg(a.j ORDER BY (a.j ->> 'severity') = 'critical' DESC, a.ord), '[]'::jsonb) AS j
  FROM att a
)
SELECT jsonb_build_object(
  'window', (SELECT jsonb_build_object('from', w.f, 'to_end', w.t, 'prev_from', w.pf, 'prev_to_end', w.pt,
                                       'days', w.ndays, 'granularity', w.gran) FROM win w),
  'freshness', (SELECT j FROM frj),
  'kpis',      (SELECT j FROM kpj) || jsonb_build_object('spark', (SELECT j FROM spkj)),
  'sources',   (SELECT jsonb_agg(sj.j ORDER BY sj.ord) FROM src_json sj),
  'trend',     (SELECT j FROM trj),
  'teams',     (SELECT j FROM teamj),
  'attention', (SELECT j FROM attj)
)
  $core$
  INTO v_out
  USING v_from, v_to, v_pf, v_pt, v_web, v_web_prev, v_web_fresh, v_web_err,
        (v_to - v_from > interval '31 days'), v_claimed, v_waiting, v_excluded, v_np_days;

  RETURN v_out;
END;
$function$;


COMMENT ON FUNCTION public.insights_overview(text, text, text, text) IS
  'Connected Overview (GET /api/insights/overview): freshness, KPI tiles (+prev, +spark), sources, trend, teams, attention — on three clocks (placed = created, sold = sale decision, cash = MEX delivery). Money included; the api strips it for non-owners. The owner''s test phones (public.report_excluded_phones) are in no figure; attention approved_no_parcel_7d uses no_parcel_rule_days() (20260940000300). Contract + definitions: migration 20260936000000.';


-- ── 8. insights_web_block — test phones out ───────────────────────────────────
-- LIVE definition (= 20260937000000). Changed: _x (the test phones, read once);
-- the placed base drops a web order on a test phone or linked to a test-phone
-- parcel; mex_only drops test-phone parcels. sync.live_orders (the mirror's
-- size, a sync-health figure) is unchanged.

CREATE OR REPLACE FUNCTION public.insights_web_block(p_from text, p_to_end text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  _from timestamptz;
  _to   timestamptz;   -- exclusive
  _f    text := nullif(btrim(coalesce(p_from, '')), '');
  _t    text := nullif(btrim(coalesce(p_to_end, '')), '');
  _res  jsonb;
  -- the owner's test phones (public.report_excluded_phones, 20260939000700),
  -- read once: their web orders and parcels are in no figure (20260940000300)
  _x    text[] := public.report_excluded_phone8s();
BEGIN
  IF _f IS NOT NULL THEN
    _from := CASE WHEN _f ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN _f::date::timestamp AT TIME ZONE 'Europe/Skopje'
                  ELSE _f::timestamptz END;
  END IF;
  IF _t IS NOT NULL THEN
    _to := CASE WHEN _t ~ '^\d{4}-\d{2}-\d{2}$'
                THEN (_t::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje'
                ELSE date_trunc('second', _t::timestamptz) + interval '1 second' END;
  END IF;

  WITH base AS (
    SELECT w.*,
           public.web_order_outcome(w.status, w.payment_status, w.payment_method) AS bucket,
           public.web_order_money(w.status, w.payment_status)                      AS money,
           (w.created_at AT TIME ZONE 'Europe/Skopje')::date                       AS d
    FROM public.web_orders w
    WHERE w.deleted_in_shop_at IS NULL
      AND (_from IS NULL OR w.created_at >= _from)
      AND (_to   IS NULL OR w.created_at <  _to)
      AND NOT public.insights_excluded8(w.phone8, _x)
      AND NOT EXISTS (SELECT 1 FROM public.mex_parcels tp
                       WHERE tp.tracking_id = w.mex_tracking_id AND tp.phone8 = ANY (_x))
  ),
  placed AS (SELECT * FROM base WHERE bucket <> 'card_unpaid'),
  bucket_names(bucket, ord) AS (
    VALUES ('awaiting', 1), ('preparing', 2), ('courier', 3), ('delivered', 4),
           ('returned', 5), ('cancelled', 6), ('no_record', 7)
  ),
  bucket_agg AS (
    SELECT b.bucket,
           count(p.shop_order_id)::integer    AS n,
           coalesce(sum(p.total), 0)          AS v
    FROM bucket_names b
    LEFT JOIN placed p ON p.bucket = b.bucket
    GROUP BY b.bucket
  ),
  daily AS (
    SELECT p.d,
           count(*)::integer                                               AS placed_count,
           sum(p.total)                                                    AS placed_value,
           count(*) FILTER (WHERE p.bucket = 'delivered')::integer         AS delivered_count,
           coalesce(sum(p.total) FILTER (WHERE p.bucket = 'delivered'), 0) AS delivered_value,
           coalesce(sum(p.total) FILTER (WHERE p.money = 'collected'), 0)  AS collected_value
    FROM placed p
    GROUP BY p.d
  ),
  courier AS (
    SELECT coalesce(btrim(p.tracking_status), '') AS status, count(*)::integer AS n
    FROM placed p WHERE p.bucket = 'courier'
    GROUP BY 1
  ),
  linked AS (
    SELECT p.shop_order_id, m.status_id, m.cod_mkd, m.delivered_at, m.returned_at
    FROM placed p
    JOIN public.mex_parcels m ON m.tracking_id = p.mex_tracking_id
  ),
  mex_only AS (
    -- NTMK-referenced parcels created in the range that no web order claims
    -- and the CRM has not linked to one of its own orders.
    SELECT m.status_id, m.cod_mkd
    FROM public.mex_parcels m
    WHERE (m.sender_reference ~ '^NTMK[0-9]+$' OR m.tracking_id ~ '^NTMK[0-9]+$')
      AND m.order_id IS NULL
      AND NOT public.insights_excluded8(m.phone8, _x)
      AND (_from IS NULL OR m.created_at_mex >= _from)
      AND (_to   IS NULL OR m.created_at_mex <  _to)
      AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                       WHERE w.mex_tracking_id = m.tracking_id
                          OR w.order_number = m.sender_reference
                          OR w.order_number = m.tracking_id)
  ),
  last_run AS (
    SELECT r.status, r.started_at, r.finished_at, r.error, r.warning, r.kind
    FROM public.web_sync_runs r
    ORDER BY r.started_at DESC
    LIMIT 1
  ),
  last_ok AS (
    SELECT max(r.finished_at) AS at FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')
  )
  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
      'from', _from, 'to_exclusive', _to, 'tz', 'Europe/Skopje', 'day_basis', 'created',
      'currency', 'MKD', 'generated_at', now()),
    'sync', jsonb_build_object(
      'last_ok_at',      (SELECT at FROM last_ok),
      'last_run_at',     (SELECT coalesce(finished_at, started_at) FROM last_run),
      'last_run_kind',   (SELECT kind FROM last_run),
      'last_run_status', (SELECT status FROM last_run),
      'last_error',      (SELECT error FROM last_run),
      'last_warning',    (SELECT warning FROM last_run),
      -- Shop rows web-sync refused to mirror (number not OC-…/NTMK…). The
      -- nightly sweep re-reads them, so a non-zero value persists until fixed.
      'rejected_24h',    (SELECT coalesce(max(r.rejected), 0)::integer FROM public.web_sync_runs r
                           WHERE r.started_at > now() - interval '26 hours'),
      'live_orders',     (SELECT count(*)::integer FROM public.web_orders WHERE deleted_in_shop_at IS NULL)),
    'placed', jsonb_build_object(
      'count',     (SELECT count(*)::integer FROM placed),
      'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed)),
    'card_unpaid', jsonb_build_object(
      'count',     (SELECT count(*)::integer FROM base WHERE bucket = 'card_unpaid'),
      'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM base WHERE bucket = 'card_unpaid')),
    'buckets', (SELECT jsonb_object_agg(bucket, jsonb_build_object('count', n, 'value_mkd', round(v, 2)))
                FROM bucket_agg),
    'money', jsonb_build_object(
      'collected_mkd',  (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'collected'),
      'to_collect_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'to_collect'),
      'lost_mkd',       (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'lost'),
      'unrecorded_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'unrecorded'),
      'partially_refunded_count',
                        (SELECT count(*)::integer FROM placed WHERE payment_status = 'PARTIALLY_REFUNDED'),
      'refunds_mirrored', false),
    'split', jsonb_build_object(
      'native', jsonb_build_object(
        'count',     (SELECT count(*)::integer FROM placed WHERE NOT is_legacy),
        'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE NOT is_legacy)),
      'legacy', jsonb_build_object(
        'count',     (SELECT count(*)::integer FROM placed WHERE is_legacy),
        'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE is_legacy))),
    'courier_status', coalesce((SELECT jsonb_agg(jsonb_build_object('status', status, 'count', n)
                                                 ORDER BY n DESC, status) FROM courier), '[]'::jsonb),
    'preparing_waybill', jsonb_build_object(
      'with_waybill',    (SELECT count(*)::integer FROM placed WHERE bucket = 'preparing' AND tracking_number IS NOT NULL),
      'without_waybill', (SELECT count(*)::integer FROM placed WHERE bucket = 'preparing' AND tracking_number IS NULL)),
    'delivery_days', (
      SELECT jsonb_build_object(
               'median', round((percentile_cont(0.5) WITHIN GROUP (
                          ORDER BY extract(epoch FROM (tracking_status_at - created_at)) / 86400))::numeric, 2),
               'n', count(*)::integer)
      FROM placed
      WHERE status = 'DELIVERED' AND tracking_status_at IS NOT NULL AND tracking_status_at > created_at),
    'mex', jsonb_build_object(
      'linked',            (SELECT count(*)::integer FROM linked),
      'delivered',         (SELECT count(*)::integer FROM linked WHERE status_id = 2),
      'delivered_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM linked WHERE status_id = 2),
      'returned',          (SELECT count(*)::integer FROM linked WHERE status_id = 7),
      'at_courier',        (SELECT count(*)::integer FROM linked WHERE status_id IS DISTINCT FROM 2
                                                                  AND status_id IS DISTINCT FROM 7)),
    'mex_only', jsonb_build_object(
      'count',             (SELECT count(*)::integer FROM mex_only),
      'delivered',         (SELECT count(*)::integer FROM mex_only WHERE status_id = 2),
      'delivered_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM mex_only WHERE status_id = 2),
      'returned',          (SELECT count(*)::integer FROM mex_only WHERE status_id = 7)),
    'non_mkd_count', (SELECT count(*)::integer FROM placed WHERE currency IS DISTINCT FROM 'MKD'),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', to_char(d::timestamp, 'YYYY-MM-DD'),
               'placed_count', placed_count,
               'placed_value_mkd', round(placed_value, 2),
               'delivered_count', delivered_count,
               'delivered_mkd', round(delivered_value, 2),
               'collected_mkd', round(collected_value, 2)) ORDER BY d)
      FROM daily), '[]'::jsonb)
  ) INTO _res;

  RETURN _res;
END;
$function$;


COMMENT ON FUNCTION public.insights_web_block(text, text) IS
  'naturatherapy.mk web block for the Overview (shop panel rules, card_unpaid excluded, day = created in Europe/Skopje, money in MKD; the owner''s test phones excluded, 20260940000300). p_from = YYYY-MM-DD or ISO; p_to_end = YYYY-MM-DD (inclusive day) or ISO (inclusive to the second). Service role only — the api gates owners.';


-- ── 9. insights_pivot — test phones out ───────────────────────────────────────
-- LIVE definition (= 20260936000000). Changed: v_x (the test phones, read once,
-- $4); an order on a test phone or holding a test-phone parcel is not in `c`.

CREATE OR REPLACE FUNCTION public.insights_pivot(p_from text, p_to_end text, p_by text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
AS $function$
DECLARE
  v_from timestamptz;
  v_to   timestamptz;
  v_by   text[];
  v_all  text[] := ARRAY['source', 'detail', 'team', 'person', 'list', 'webmaster', 'stream', 'product', 'city'];
  v_bad  text;
  v_out  jsonb;
  -- the owner's test phones (public.report_excluded_phones), read once ($4)
  v_x    text[] := public.report_excluded_phone8s();
BEGIN
  IF nullif(btrim(coalesce(p_from, '')), '') IS NULL OR nullif(btrim(coalesce(p_to_end, '')), '') IS NULL THEN
    RAISE EXCEPTION 'insights_pivot: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  v_from := p_from::timestamptz;
  v_to   := p_to_end::timestamptz;
  IF v_to < v_from OR v_to - v_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_pivot: bad window' USING ERRCODE = '22023';
  END IF;
  SELECT array_agg(DISTINCT lower(btrim(b))) INTO v_by
    FROM unnest(coalesce(p_by, ARRAY[]::text[])) b WHERE nullif(btrim(b), '') IS NOT NULL;
  IF v_by IS NULL OR cardinality(v_by) = 0 OR cardinality(v_by) > 4 THEN
    RAISE EXCEPTION 'insights_pivot: choose 1 to 4 dimensions' USING ERRCODE = '22023';
  END IF;
  SELECT b INTO v_bad FROM unnest(v_by) b WHERE NOT (b = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_pivot: unknown dimension %', v_bad USING ERRCODE = '22023';
  END IF;
  -- keep the caller's order for the response
  SELECT array_agg(b ORDER BY i) INTO v_by
    FROM (SELECT DISTINCT ON (lower(btrim(b))) lower(btrim(b)) AS b, i
            FROM unnest(p_by) WITH ORDINALITY u(b, i)
           WHERE nullif(btrim(b), '') IS NOT NULL
           ORDER BY lower(btrim(b)), i) z;

  EXECUTE $pv$
WITH
c AS (
  SELECT x.id, x.status::text AS status, coalesce(x.price, 0)::numeric AS price,
         CASE WHEN x.sale_source IN ('altercpa', 'affiliate') THEN 'altercpa'
              WHEN x.sale_source = 'elyon_crm' THEN 'elyon_crm'
              WHEN x.sale_source = 'web' THEN 'web'
              ELSE 'teleshop_other' END AS source,
         coalesce(x.sale_source_detail, '(none)') AS detail,
         x.sold_by_person_id, x.sold_at,
         coalesce(nullif(btrim(x.prediction_list_name), ''), '(none)') AS list,
         x.cpa_webmaster_id,
         coalesce(nullif(btrim(x.cpa_stream_id), ''), '(none)') AS stream,
         coalesce(nullif(btrim(x.product_name), ''), '(none)') AS product,
         coalesce(nullif(btrim(x.customer_city), ''), '(none)') AS city,
         (coalesce(x.sale_source_detail, '') <> 'disposition'
          AND (x.sold_at IS NOT NULL OR x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))) AS is_sale,
         (x.status IN ('paid', 'delivered')) AS is_delivered,
         CASE WHEN x.status IN ('paid', 'delivered') THEN
              CASE WHEN x.mex_delivered_at IS NOT NULL AND x.mex_cod_mkd IS NOT NULL
                   THEN x.mex_cod_mkd::numeric ELSE round(coalesce(x.price, 0) * 61.5) END END AS cash_mkd,
         (x.status = 'returned') AS is_returned,
         (x.status = 'returned' OR (x.status IN ('cancelled', 'trashed') AND x.sold_at IS NOT NULL)) AS is_lost
  FROM public.orders x
  WHERE x.created_at BETWEEN $1 AND $2
    AND (x.source_type IS NULL OR x.source_type <> 'monadon_legacy')
    -- a test-phone order, or one holding a test-phone parcel, is in no report
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4::text[])
    AND NOT coalesce(x.mex_tracking_id IN (SELECT p.tracking_id FROM public.mex_parcels p
                                            WHERE p.phone8 = ANY ($4::text[])), false)
),
e AS (
  SELECT c.*,
         coalesce(sp.display_name, CASE WHEN c.sold_by_person_id IS NULL THEN '(none)' ELSE '(unknown)' END) AS person,
         coalesce(st.name, '(none)') AS team,
         CASE WHEN c.cpa_webmaster_id IS NULL THEN '(none)'
              ELSE coalesce(wm.name, 'WM ' || c.cpa_webmaster_id) END AS webmaster
  FROM c
  LEFT JOIN public.sales_people sp ON sp.id = c.sold_by_person_id
  LEFT JOIN LATERAL (
    SELECT m.team_key FROM public.sales_team_members m
     WHERE m.person_id = c.sold_by_person_id AND m.is_primary
       AND m.valid_from <= (c.sold_at AT TIME ZONE 'Europe/Skopje')::date
       AND coalesce(m.valid_to, 'infinity'::date) >= (c.sold_at AT TIME ZONE 'Europe/Skopje')::date
     ORDER BY m.valid_from DESC LIMIT 1) tmm ON c.sold_by_person_id IS NOT NULL AND c.sold_at IS NOT NULL
  LEFT JOIN public.sales_teams st ON st.key = tmm.team_key
  LEFT JOIN public.altercpa_webmasters wm ON wm.wm_id = c.cpa_webmaster_id
),
g AS (
  SELECT
    CASE WHEN 'source'    = ANY ($3) THEN e.source    END AS source,
    CASE WHEN 'detail'    = ANY ($3) THEN e.detail    END AS detail,
    CASE WHEN 'team'      = ANY ($3) THEN e.team      END AS team,
    CASE WHEN 'person'    = ANY ($3) THEN e.person    END AS person,
    CASE WHEN 'person'    = ANY ($3) THEN e.sold_by_person_id END AS person_id,
    CASE WHEN 'list'      = ANY ($3) THEN e.list      END AS list,
    CASE WHEN 'webmaster' = ANY ($3) THEN e.webmaster END AS webmaster,
    CASE WHEN 'stream'    = ANY ($3) THEN e.stream    END AS stream,
    CASE WHEN 'product'   = ANY ($3) THEN e.product   END AS product,
    CASE WHEN 'city'      = ANY ($3) THEN e.city      END AS city,
    count(*)                                              AS n,
    count(*) FILTER (WHERE e.is_sale)                     AS sold,
    sum(e.price)                                          AS placed_eur,
    coalesce(sum(e.price) FILTER (WHERE e.is_sale), 0)    AS sold_eur,
    count(*) FILTER (WHERE e.is_delivered)                AS delivered,
    coalesce(sum(e.cash_mkd), 0)                          AS cash_mkd,
    count(*) FILTER (WHERE e.is_returned)                 AS returned,
    count(*) FILTER (WHERE e.is_lost)                     AS lost
  FROM e
  GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
),
r AS (
  SELECT g.*, row_number() OVER (ORDER BY g.sold_eur DESC, g.n DESC, g.source, g.detail, g.team, g.person,
                                          g.list, g.webmaster, g.stream, g.product, g.city) AS rn,
         count(*) OVER () AS total_rows
  FROM g
)
SELECT jsonb_build_object(
  'by', to_jsonb($3),
  'total_rows', coalesce(max(r.total_rows), 0),
  'truncated', coalesce(max(r.total_rows), 0) > 2000,
  'rows', coalesce(jsonb_agg(
     (jsonb_build_object('source', r.source, 'detail', r.detail, 'team', r.team, 'person', r.person,
                         'person_id', r.person_id, 'list', r.list, 'webmaster', r.webmaster,
                         'stream', r.stream, 'product', r.product, 'city', r.city)
      - ARRAY(SELECT k FROM unnest(ARRAY['source', 'detail', 'team', 'person', 'list', 'webmaster', 'stream', 'product', 'city']) k
              WHERE NOT (k = ANY ($3)))
      - CASE WHEN 'person' = ANY ($3) THEN ARRAY[]::text[] ELSE ARRAY['person_id'] END)
     || jsonb_build_object(
          'count', r.n, 'sold', r.sold,
          'placed_value_eur', round(r.placed_eur, 2), 'value_eur', round(r.sold_eur, 2),
          'delivered', r.delivered, 'delivered_cash_mkd', round(r.cash_mkd),
          'returned', r.returned, 'lost', r.lost)
     ORDER BY r.rn) FILTER (WHERE r.rn <= 2000), '[]'::jsonb)
)
FROM r
  $pv$
  INTO v_out
  USING v_from, v_to, v_by, v_x;

  RETURN v_out;
END;
$function$;


COMMENT ON FUNCTION public.insights_pivot(text, text, text[]) IS
  'Drill-down pivot for GET /api/insights/pivot: orders placed in the window grouped by 1-4 of source/detail/team/person/list/webmaster/stream/product/city; counts, sold value, delivered cash. The owner''s test phones excluded (20260940000300). Owners only (api gate); service_role only.';


-- ── 10. The read-only harness ─────────────────────────────────────────────────
-- scripts/verify-attribution.mjs, scripts/backfill-web-parcel-links.mjs and the
-- Overview replays run as supabase_read_only_user (pg_read_all_data): EXECUTE on
-- the readers widens nothing. Conditional (the 20260936000000 pattern).

DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.no_parcel_rule_days()                            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.web_phone_link_candidates(integer[], integer)   TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
