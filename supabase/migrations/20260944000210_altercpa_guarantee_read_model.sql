-- ============================================================================
-- AlterCPA 30% guarantee — the read model (plan 01.10.2026, Фаза 3)
-- ============================================================================
-- Owner decision 01.10.2026: the guarantee rate is
--
--     (approved + cancel_other) ÷ ALL Macedonian leads        target 30%
--
-- read straight off AlterCPA's own decision (altercpa_leads.decision, kept by
-- the ledger trigger — altercpa_decision() in 20260935000100): approved = phase
-- 3; cancel_other = phase 4 with a reason that is not a real cancel (the
-- 2026-08-11 manager rule: a confirmed sale awaiting fulfilment); cancelled /
-- trashed = phase 4 / 5; NULL = still OPEN ("Отворени" — never "На чекање",
-- that word is only the CRM order status pending).
--
-- It REPLACES the 20260922000000 metric (sticky CRM status through
-- order_history) as the number the deal is judged on. That old number stays
-- here one release as `crm_sticky` — a muted "Стар метод" figure, so a manager
-- who saw ~49% yesterday can see why today says ~36% — and goes in Фаза 8.
--
-- ONE definition, used by every reader (the /altercpa Денес · Стапки · Лидови
-- tabs and, from 20260944000300, the alerts):
--   cohort      the Skopje ARRIVAL day of COALESCE(created_remote, first_seen_at);
--               bounds (d)::timestamp AT TIME ZONE crm_tz() — never "+ interval
--               '1 day'" on a timestamptz (DST days are 23 h / 25 h).
--   population  geo = app_settings.altercpa_rate_geo (stored upper-case, so the
--               comparison is a plain = that idx_altercpa_leads_geo_arrival
--               answers — no upper()).
--   test        shown apart, never in the rate: AlterCPA's own test orders
--               (skip_reason 'test_order' — the sync's name/phone test), the
--               owner's test phones (report_excluded_phone8s(), law 28.09) and
--               any webmaster in app_settings.altercpa_rate_excluded_webmasters
--               (default []; the owner may list 3226 "test" without a migration).
--   N           leads that are not test
--   C (counted) approved + cancel_other
--   O (open)    decision IS NULL
--   required    ceil(target · N / 100) in NUMERIC — never 0.3 * N in floating
--               point (0.3 * 70 = 20.999… → 21 is right only by luck)
--   need        max(0, required − C)   = altercpa_need_confirm()
--   secondary   mex_shipped: the lead's CRM order has a real MEX parcel that
--               left the warehouse (status 1,2,3,4,7,9,10,13 — 8 is "за
--               пакување", not shipped); crm_sticky: the old metric.
--
-- Everything here is NEW. Nothing existing is replaced; the old functions, the
-- triggers and the altercpa-rate-verdicts cron are untouched until
-- 20260944000300 (applied after 20:55). altercpa-sync is not involved.
--
-- Reference numbers (01.10.2026): September = 5.754 MK leads, 76 test,
-- approved 1.760 + cancel_other 284 = 2.044 → 35,5% raw / ≈36,0% without test.
-- Checks: node scripts/verify-altercpa-guarantee.mjs (G1–G8, read-only).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 1. Two new knobs (no migration needed to retune) ───────────────────────
INSERT INTO public.app_settings (key, value) VALUES
  ('altercpa_rate_excluded_webmasters', '[]'::jsonb),  -- wm ids left out of the rate, shown apart
  ('altercpa_rate_digest_hour',         '18'::jsonb)   -- local hour of the daily digest (20260944000300)
ON CONFLICT (key) DO NOTHING;

-- ── 2. The arithmetic, once ────────────────────────────────────────────────
-- How many more confirmations the cohort needs to reach the target.
-- NUMERIC throughout: p_target 30 and p_leads 70 give exactly 21.
CREATE OR REPLACE FUNCTION public.altercpa_need_confirm(p_counted integer, p_leads integer, p_target numeric)
RETURNS integer
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT GREATEST(0,
           ceil(GREATEST(coalesce(p_target, 30), 0)::numeric * GREATEST(coalesce(p_leads, 0), 0)::numeric / 100)::integer
           - coalesce(p_counted, 0));
$fn$;
COMMENT ON FUNCTION public.altercpa_need_confirm(integer, integer, numeric) IS
  'AlterCPA guarantee: max(0, ceil(target·leads/100) − counted), in numeric (no 0.3·N float trap). Twin of guaranteeMath() in supabase/functions/api/altercpaGuarantee.ts. Migration 20260944000210.';

-- ── 3. One row per lead — every reader counts through THIS ─────────────────
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_base(p_from date, p_to date)
RETURNS TABLE (
  lead_id                  uuid,
  altercpa_id              text,
  account_id               uuid,
  day                      date,
  arrived_at               timestamptz,
  webmaster                text,
  stream                   text,
  offer_name               text,
  offer_ext_id             text,
  decision                 text,
  reason                   integer,
  decided_at               timestamptz,
  decided_by_altercpa_user integer,
  order_id                 uuid,
  display_id               text,
  crm_status               text,
  mex_status_id            integer,
  mex_tracking_id          text,
  customer_name            text,
  phone_raw                text,
  is_test                  boolean,
  mex_shipped              boolean,
  crm_sticky               boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  -- Config read ONCE per call (a one-row MATERIALIZED CTE), never per lead.
  WITH cfg AS MATERIALIZED (
    SELECT
      coalesce((SELECT s.value #>> '{}' FROM public.app_settings s WHERE s.key = 'altercpa_rate_geo'), 'MK') AS geo,
      coalesce((SELECT array_agg(x.v)
                  FROM public.app_settings s,
                       jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) AS x(v)
                 WHERE s.key = 'altercpa_rate_excluded_webmasters'), ARRAY[]::text[]) AS wm_ex,
      public.report_excluded_phone8s() AS phones,
      (p_from::timestamp AT TIME ZONE public.crm_tz())       AS t0,
      ((p_to + 1)::timestamp AT TIME ZONE public.crm_tz())   AS t1
    WHERE p_from IS NOT NULL AND p_to IS NOT NULL
      AND p_to >= p_from AND p_to - p_from <= 400          -- a runaway range is no range
  )
  SELECT
    l.id,
    l.altercpa_id,
    l.account_id,
    (coalesce(l.created_remote, l.first_seen_at) AT TIME ZONE public.crm_tz())::date,
    coalesce(l.created_remote, l.first_seen_at),
    coalesce(l.webmaster, '(none)'),
    -- the rule of orders.cpa_stream_id (tracking.exts — never extu, the click id)
    coalesce(nullif(left(btrim(l.payload -> 'tracking' ->> 'exts'), 120), ''), '(none)'),
    coalesce(l.offer_name, '(blank)'),
    l.offer_ext_id,
    l.decision,
    l.reason::integer,
    l.decided_at,
    l.decided_by_altercpa_user,
    l.order_id,
    o.display_id,
    o.status::text,
    o.mex_status_id,
    o.mex_tracking_id,
    l.customer_name,
    l.phone_raw,
    (   l.skip_reason IS NOT DISTINCT FROM 'test_order'
     OR right(regexp_replace(coalesce(l.phone_e164, l.phone_raw, ''), '[^0-9]', '', 'g'), 8) = ANY (c.phones)
     OR coalesce(l.webmaster, '(none)') = ANY (c.wm_ex)),
    coalesce(o.mex_tracking_id IS NOT NULL AND o.mex_status_id IN (1, 2, 3, 4, 7, 9, 10, 13), false),
    -- the OLD metric, exactly public.altercpa_lead_is_confirmed() (20260922000000), inlined
    -- (a SECURITY DEFINER call per lead cannot be inlined by the planner)
    (l.order_id IS NOT NULL
     AND (o.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
          OR EXISTS (SELECT 1 FROM public.order_history h
                      WHERE h.order_id = l.order_id
                        AND h.to_status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned'))))
  FROM cfg c
  JOIN public.altercpa_leads l
    ON l.geo = c.geo
   AND coalesce(l.created_remote, l.first_seen_at) >= c.t0
   AND coalesce(l.created_remote, l.first_seen_at) <  c.t1
  LEFT JOIN public.orders o ON o.id = l.order_id;
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_base(date, date) IS
  'AlterCPA guarantee: one row per lead of the rate geo that ARRIVED (COALESCE(created_remote, first_seen_at)) on Skopje days p_from..p_to (≤ 400 days). is_test = AlterCPA test order OR owner test phone OR excluded webmaster — never in the rate. mex_shipped = CRM order at MEX 1,2,3,4,7,9,10,13. crm_sticky = the old 20260922000000 metric (one release). Every guarantee reader counts through this. Migration 20260944000210.';

-- ── 4. The counts: day / webmaster / stream / offer in ONE pass ────────────
-- GROUPING SETS so the four grains can never disagree. Bucket counts exclude
-- test leads; test_excluded counts them apart. Invariant (checked by G1):
--   leads = approved + cancel_other + cancelled + trashed + open
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_rates(p_from date, p_to date)
RETURNS TABLE (
  grain         text,     -- 'day' | 'webmaster' | 'stream' | 'offer'
  day           date,
  webmaster     text,
  stream        text,
  offer_name    text,
  leads         integer,  -- N: not test
  test_excluded integer,
  approved      integer,
  cancel_other  integer,
  cancelled     integer,
  trashed       integer,
  open          integer,
  counted       integer,  -- C = approved + cancel_other
  mex_shipped   integer,
  crm_sticky    integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT
    CASE WHEN GROUPING(b.webmaster) = 1 THEN 'day'
         WHEN GROUPING(b.stream) = 0     THEN 'stream'
         WHEN GROUPING(b.offer_name) = 0 THEN 'offer'
         ELSE 'webmaster' END,
    b.day,
    CASE WHEN GROUPING(b.webmaster) = 0  THEN b.webmaster END,
    CASE WHEN GROUPING(b.stream) = 0     THEN b.stream END,
    CASE WHEN GROUPING(b.offer_name) = 0 THEN b.offer_name END,
    count(*) FILTER (WHERE NOT b.is_test)::integer,
    count(*) FILTER (WHERE b.is_test)::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision = 'approved')::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision = 'cancel_other')::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision = 'cancelled')::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision = 'trashed')::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision IS NULL)::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.decision IN ('approved', 'cancel_other'))::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.mex_shipped)::integer,
    count(*) FILTER (WHERE NOT b.is_test AND b.crm_sticky)::integer
  FROM public.altercpa_guarantee_base(p_from, p_to) b
  GROUP BY GROUPING SETS ((b.day), (b.day, b.webmaster), (b.day, b.webmaster, b.stream), (b.day, b.webmaster, b.offer_name))
  ORDER BY 2 DESC, 1, 3 NULLS FIRST, 4 NULLS FIRST, 5 NULLS FIRST;
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_rates(date, date) IS
  'AlterCPA guarantee counts per Skopje arrival day at four grains (day / webmaster / webmaster+stream / webmaster+offer) in one GROUPING SETS pass. leads = N (not test) = approved + cancel_other + cancelled + trashed + open; counted = approved + cancel_other; test_excluded apart. The deal is judged at the webmaster grain; stream/offer are diagnosis. Migration 20260944000210.';

-- ── 5. The open leads — who still has to be decided, oldest first ──────────
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_open(p_from date, p_to date, p_limit integer DEFAULT 500)
RETURNS TABLE (
  lead_id         uuid,
  altercpa_id     text,
  day             date,
  arrived_at      timestamptz,
  webmaster       text,
  stream          text,
  offer_name      text,
  customer_name   text,
  order_id        uuid,
  display_id      text,
  crm_status      text,
  mex_status_id   integer,
  mex_tracking_id text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT b.lead_id, b.altercpa_id, b.day, b.arrived_at, b.webmaster, b.stream, b.offer_name,
         b.customer_name, b.order_id, b.display_id, b.crm_status, b.mex_status_id, b.mex_tracking_id
  FROM public.altercpa_guarantee_base(p_from, p_to) b
  WHERE NOT b.is_test AND b.decision IS NULL
  ORDER BY b.arrived_at ASC, b.lead_id
  LIMIT GREATEST(1, LEAST(coalesce(p_limit, 500), 2000));
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_open(date, date, integer) IS
  'AlterCPA guarantee: the OPEN (decision IS NULL), non-test leads that arrived p_from..p_to, oldest first, with the CRM order (display_id, status, MEX). Migration 20260944000210.';

-- ── 6. The lead list ("Лидови"): every lead, filterable, one page ──────────
-- p_decision: approved | cancel_other | cancelled | trashed | open (= IS NULL).
-- p_q: an altercpa id, a CRM display id (ORD-362061 or 362061), ≥ 6 digits =
-- phone (last 8 digits), otherwise part of the customer name. Newest first.
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_journal(
  p_from         date,
  p_to           date,
  p_wm           text    DEFAULT NULL,
  p_stream       text    DEFAULT NULL,
  p_offer        text    DEFAULT NULL,
  p_decision     text    DEFAULT NULL,
  p_q            text    DEFAULT NULL,
  p_include_test boolean DEFAULT false,
  p_limit        integer DEFAULT 50,
  p_offset       integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  WITH q AS (
    SELECT nullif(btrim(coalesce(p_q, '')), '')                     AS txt,
           regexp_replace(coalesce(p_q, ''), '[^0-9]', '', 'g')      AS digits
  ),
  f AS (
    SELECT b.*
    FROM public.altercpa_guarantee_base(p_from, p_to) b
    CROSS JOIN q
    WHERE (coalesce(p_include_test, false) OR NOT b.is_test)
      AND (p_wm IS NULL OR b.webmaster = p_wm)
      AND (p_stream IS NULL OR b.stream = p_stream)
      AND (p_offer IS NULL OR b.offer_name = p_offer)
      AND (p_decision IS NULL
           OR (p_decision = 'open' AND b.decision IS NULL)
           OR b.decision = p_decision)
      AND (q.txt IS NULL
           OR b.altercpa_id = q.txt
           OR upper(b.display_id) = upper(q.txt)
           OR upper(b.display_id) = 'ORD-' || q.txt
           OR (length(q.digits) >= 6
               AND strpos(regexp_replace(coalesce(b.phone_raw, ''), '[^0-9]', '', 'g'), right(q.digits, 8)) > 0)
           OR (length(q.digits) < 6
               AND strpos(lower(coalesce(b.customer_name, '')), lower(q.txt)) > 0))
  ),
  page AS (
    SELECT f.*
    FROM f
    ORDER BY f.arrived_at DESC, f.lead_id
    LIMIT GREATEST(1, LEAST(coalesce(p_limit, 50), 200))
    OFFSET GREATEST(0, coalesce(p_offset, 0))
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM f),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'lead_id', p.lead_id,
               'altercpa_id', p.altercpa_id,
               'day', p.day,
               'arrived_at', p.arrived_at,
               'webmaster', p.webmaster,
               'stream', p.stream,
               'offer_name', p.offer_name,
               'offer_ext_id', p.offer_ext_id,
               'decision', p.decision,
               'reason', p.reason,
               'decided_at', p.decided_at,
               'decided_by_altercpa_user', p.decided_by_altercpa_user,
               'operator_name', op.display_name,
               'order_id', p.order_id,
               'display_id', p.display_id,
               'crm_status', p.crm_status,
               'mex_status_id', p.mex_status_id,
               'mex_tracking_id', p.mex_tracking_id,
               'customer_name', p.customer_name,
               'phone_raw', p.phone_raw,
               'is_test', p.is_test,
               'mex_shipped', p.mex_shipped)
             ORDER BY p.arrived_at DESC, p.lead_id)
      FROM page p
      -- the AlterCPA operator who decided: their user id → a sales person
      LEFT JOIN LATERAL (
        SELECT sp.display_name
        FROM public.sales_person_identities i
        JOIN public.sales_people sp ON sp.id = i.person_id
        WHERE p.decided_by_altercpa_user IS NOT NULL
          AND i.kind = 'altercpa_user'
          AND i.value = p.decided_by_altercpa_user::text
          AND (i.account_id = p.account_id OR i.account_id IS NULL)
        ORDER BY (i.account_id IS NOT DISTINCT FROM p.account_id) DESC
        LIMIT 1
      ) op ON true
    ), '[]'::jsonb));
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_journal(date, date, text, text, text, text, text, boolean, integer, integer) IS
  'AlterCPA "Лидови": {total, rows} of the guarantee leads (altercpa_guarantee_base) with arrival, webmaster, stream, offer, decision, reason, decided_at, the AlterCPA operator (sales_person_identities kind altercpa_user), the CRM order and MEX. Test leads only with p_include_test. Newest first, ≤ 200 a page. PII is masked by the api, not here. Migration 20260944000210.';

-- ── 7. Freshness: when did the 2-minute sync last see anything ─────────────
CREATE OR REPLACE FUNCTION public.altercpa_guarantee_freshness()
RETURNS TABLE (leads_seen_at timestamptz, decisions_seen_at timestamptz, newest_arrival_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT max(l.last_seen_at), max(l.phase_seen_at), max(coalesce(l.created_remote, l.first_seen_at))
  FROM public.altercpa_leads l
  WHERE l.geo = coalesce((SELECT s.value #>> '{}' FROM public.app_settings s WHERE s.key = 'altercpa_rate_geo'), 'MK');
$fn$;
COMMENT ON FUNCTION public.altercpa_guarantee_freshness() IS
  'AlterCPA guarantee freshness line: max(last_seen_at) (leads), max(phase_seen_at) (decisions), newest arrival — of the rate geo. Migration 20260944000210.';

-- ── 8. Grants: the api (service role) only; the verifier reads ─────────────
REVOKE ALL ON FUNCTION public.altercpa_need_confirm(integer, integer, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_base(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_rates(date, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_open(date, date, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_journal(date, date, text, text, text, text, text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_guarantee_freshness() FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.altercpa_need_confirm(integer, integer, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_base(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_rates(date, date) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_open(date, date, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_journal(date, date, text, text, text, text, text, boolean, integer, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_freshness() TO service_role;

-- scripts/verify-altercpa-guarantee.mjs runs as supabase_read_only_user through the
-- Management API. Conditional so a fresh local database without the platform role still
-- migrates (the 20260939000700 pattern). crm_tz() is a constant; the verifier needs it to
-- recompute the cohort bounds itself.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.altercpa_need_confirm(integer, integer, numeric) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_base(date, date) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_rates(date, date) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_open(date, date, integer) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_journal(date, date, text, text, text, text, text, boolean, integer, integer) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.altercpa_guarantee_freshness() TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.crm_tz() TO supabase_read_only_user;
  END IF;
END
$grant$;

COMMIT;

NOTIFY pgrst, 'reload schema';
