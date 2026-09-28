-- ============================================================================
-- INSIGHTS → RETURNS (Враќања) and PRODUCTS & STOCK (Производи и залихи)
-- (2026-09-28, owner rules of 2026-09-28 — docs/handoff/2026-09-28/
-- wp0-cohort-contract.md; audit: audit-per-tab.md "stock / returns" and
-- audit-critic.md M5, M11, C13)
--
-- Read-side only: no table is written, no trigger, no backfill, no cron. One
-- partial index. Built ON the foundation (20260940000000 / 20260940000300 —
-- insights_sale_rows, the cohort_* rules, mk_city_key, product_key /
-- order_line_kind); nothing of it is replaced, and neither are the old RPCs
-- (insights_orders_rollup / insights_products / insights_overview …).
--
-- Adds:
--   insights_parcel_rows(p_from, p_to_end, p_event)  one row per MEX parcel of
--       an EVENT, each parcel once, with its owner (the foundation's rule: a
--       live web order's claim → the real order holding it → MEX-only):
--         created     MEX created it in the window (created_at_mex)
--         delivered   delivered in the window (delivered_at — = insights_cash_rows)
--         returned    status 7 and returned in the window (returned_at)
--         closed      delivered ∪ returned (a parcel that FINISHED in the window)
--         problem_now status 3 / 9 / 13 NOW (no window)
--         label_now   status 8 NOW (no window)
--   insights_returns(p_from, p_to_end, p_clock, p_prev_from, p_prev_to_end,
--                    p_sources, p_money) → jsonb   GET /api/insights/returns
--   insights_stock(p_from, p_to_end, p_prev_from, p_prev_to_end, p_sources,
--                  p_money) → jsonb                GET /api/insights/stock
--
-- ── RETURNS: two clocks, said on every widget ──────────────────────────────
--   sale (default, the cohort): the period's SALES (insights_sale_rows, sale
--       day, Skopje) and how many of them came back SO FAR — returned = the
--       cohort's `returned` bucket (MEX 7, or CRM returned with no parcel), so
--       the tab ties to GET /insights/cohort for the same window and sources,
--       by construction. A young period is still maturing: the payload says
--       how much of it is still open (at the courier / label / to pack).
--   returned (MEX return day): what PHYSICALLY came back in the period — every
--       parcel with status 7 and returned_at in the window, both accounts, all
--       four sources, each parcel once (= the MEX register less the test
--       phones). Its base is every parcel that FINISHED in the window
--       (delivered ∪ returned), so the rate reads "of what finished, how much
--       came back". The delivered part equals insights_cash_rows.
--   Cancelled / trashed AFTER the sale (sold, then cancelled, no parcel) are
--   shown apart, never as returns; pre-sale cancels are lead outcomes and are
--   not on this tab. "Rejected" (MEX 13) is still AT the courier until MEX
--   says 7 — shown as "at the courier with a problem", with 9 (attempted) and
--   3 (problematic), never as returned.
--   The return REASON is not knowable today (return_reason is empty on every
--   row and the MEX feed carries only the current status), so there is no
--   reason card: the tab shows what IS known — product, city, seller, list,
--   weekday, days from sale to return, the same phone returning again.
--   Round-trip loss = returned parcels × courier_rates('mex').return_cost
--   (0 ден on the rate card today — owner to confirm whether MEX bills the
--   150 ден outbound on a parcel that comes back; the payload also carries
--   what that would be, parcels × deliver_cost).
--
-- ── STOCK ───────────────────────────────────────────────────────────────────
--   Units = the item LINES of the period's cohort sales (order_items for
--   orders, web_order_items for the shop; a MEX-only parcel carries no
--   product data and is counted apart). A line's product: product_key()
--   (its product_id, else a reviewed alias), and a name that equals exactly
--   ONE active catalogue name folds into that product. Its kind:
--   order_line_kind() (reviewed aliases) first; until product_aliases is
--   seeded, the unmistakable non-products are recognised by name — loyalty
--   points (ПОЕН-…), notes (ЗАБЕЛЕШКА …), flyers, the delivery line — and a
--   0-price line (a web GIFT) is a free unit; a quantity of 100+ on one line
--   is a data error (e.g. 1.000 × Adenofrin at €0,05) and is not counted.
--   Returned units = the lines of the parcels MEX returned in the period.
--   The queue NOW: sold, waiting in the warehouse — to pack (the cohort's
--   to_pack: confirmed, no parcel; web "preparing" with no parcel) and label
--   printed (MEX 8), by the age of the sale.
--   Stock on hand is shown ONLY for warehouse-tracked products (a ledger row
--   or a non-zero count; the rest are "not tracked", never "out of stock"),
--   and the payload says whether the count can be trusted: it was counted
--   (manual adjust / BigArena sync) AND the ledger follows the shipments (its
--   last deduction is within 3 days of the last MEX parcel). Until then days
--   of cover and the valuation are NOT sent (28.09: last count 06.08 — the
--   1.000-per-product placeholder — last deduction 20.08, ~10.000 parcels
--   created since).
--
-- ── Money ───────────────────────────────────────────────────────────────────
-- Values are денари: parcel COD when a parcel exists, else price × 61,5 (the
-- FROZEN peg), web: the shop total — the foundation's value_mkd. p_money =
-- false removes every *_mkd key (absent, never 0; insights_strip_money) and
-- the valuation; the api strips again by whitelist. Test phones are in
-- nothing (the foundation's list, public.report_excluded_phones).
--
-- ── Technique ───────────────────────────────────────────────────────────────
-- plpgsql + EXECUTE … USING (each call planned with its real bounds), SECURITY
-- DEFINER, pinned search_path, service_role EXECUTE only (+ the read-only
-- harness role), `SET jit = off`, work_mem 64MB. The heavy joins (the register
-- and order_items against a whole period's sales) are HASH joins on purpose —
-- their keys are wrapped so the planner, which cannot see a set-returning
-- function's real row count, does not probe an index once per sale. Measured
-- on live data 28.09 (the timing harness sets the same work_mem / jit):
-- returns, one year: sale clock 2,9 s (of which the foundation's
-- insights_sale_rows 1,4 s), MEX clock 1,8 s; a month with compare 0,6–0,8 s;
-- stock, one year 2,4 s, a month with compare 0,9 s. The comparison is
-- computed only for windows up to 93 days (a year's comparison would double
-- the scan); beyond that meta.has_prev = false.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regprocedure('public.insights_sale_rows(timestamptz, timestamptz, boolean)') IS NULL
     OR to_regprocedure('public.cohort_order_bucket(text, numeric, timestamptz, text, text, text, text, integer, integer, timestamptz, boolean)') IS NULL
     OR to_regprocedure('public.cohort_parcel_split(text, text, text, text)') IS NULL
     OR to_regprocedure('public.mk_city_key(text)') IS NULL
     OR to_regprocedure('public.product_key(text, text, uuid)') IS NULL
     OR to_regprocedure('public.order_line_kind(text, text)') IS NULL
     OR to_regprocedure('public.insights_strip_money(jsonb)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL THEN
    RAISE EXCEPTION 'apply 20260940000000_insights_foundation.sql (and 20260939000700) first';
  END IF;
END
$dep$;

-- MEX returns are read by their return day.
CREATE INDEX IF NOT EXISTS idx_mex_parcels_returned_at
  ON public.mex_parcels (returned_at) WHERE returned_at IS NOT NULL;

-- ── 1. insights_parcel_rows — one row per MEX parcel of an event ───────────
-- Ownership exactly as insights_cash_rows (20260940000000): a live web
-- order's claim wins → else the real (non-disposition) order holding the
-- tracking id, the first-created non-test one when two hold it → else the
-- order mex_parcels.order_id names → else MEX-only (split by
-- cohort_parcel_split). The test phones' parcels, and a parcel only a test
-- order / test web order holds, are in no row.
--   outcome     delivered (2) | returned (7) | problem (3/9/13) | label (8) | moving
--   sale_at     the owner's sale day (orders: sold_at → AlterCPA ledger →
--               confirmed_at → created_at; web: created_at; MEX-only: created_at_mex)
CREATE OR REPLACE FUNCTION public.insights_parcel_rows(
  p_from   timestamptz,
  p_to_end timestamptz,
  p_event  text)
RETURNS TABLE (
  kind           text,
  source         text,
  split          text,
  sale_source    text,
  tracking_id    text,
  account        text,
  series         text,
  status_id      integer,
  outcome        text,
  created_at_mex timestamptz,
  delivered_at   timestamptz,
  returned_at    timestamptz,
  cod_mkd        numeric,
  sale_at        timestamptz,
  order_id       uuid,
  display_id     text,
  web_id         integer,
  phone8         text,
  receiver_city  text,
  receiver_name  text,
  person_id      uuid,
  list_id        uuid,
  list_name      text,
  crm_status     text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
BEGIN
  IF p_event IS NULL OR p_event NOT IN ('created', 'delivered', 'returned', 'closed', 'problem_now', 'label_now') THEN
    RAISE EXCEPTION 'insights_parcel_rows: unknown event %', p_event USING ERRCODE = '22023';
  END IF;
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_parcel_rows: bad window' USING ERRCODE = '22023';
  END IF;

  -- $1 from · $2 to_end · $3 event · $4 the test phones' last-8 digits
  RETURN QUERY EXECUTE $pr$
WITH
dp AS MATERIALIZED (
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.sender_reference, p.cod_mkd,
         p.created_at_mex, p.delivered_at, p.returned_at, p.order_id, p.phone8,
         p.receiver_city, p.receiver_name
  FROM public.mex_parcels p
  WHERE (($3 = 'created' AND p.created_at_mex BETWEEN $1 AND $2)
      OR ($3 IN ('closed', 'returned') AND p.status_id = 7 AND p.returned_at BETWEEN $1 AND $2)
      OR ($3 IN ('closed', 'delivered') AND p.delivered_at BETWEEN $1 AND $2)
      OR ($3 = 'problem_now' AND p.status_id IN (3, 9, 13))
      OR ($3 = 'label_now' AND p.status_id = 8))
    AND NOT public.insights_excluded8(p.phone8, $4)
),
led AS MATERIALIZED (
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
wcl AS (
  SELECT DISTINCT ON (w.mex_tracking_id)
         w.mex_tracking_id AS tr, w.shop_order_id, w.order_number, w.created_at, w.payment_method, w.status,
         public.insights_excluded8(w.phone8, $4) AS test
  FROM public.web_orders w
  JOIN dp ON dp.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
  ORDER BY w.mex_tracking_id, w.created_at DESC, w.shop_order_id DESC
),
oh AS (
  SELECT x.id, x.display_id, x.sale_source, x.sale_source_detail, x.status::text AS status,
         x.sold_by_person_id, x.prediction_list_id, x.prediction_list_name, x.created_at,
         x.mex_tracking_id, x.customer_phone,
         coalesce(x.sold_at, led.decided_at, x.confirmed_at, x.created_at) AS sale_at,
         public.insights_excluded8(public.insights_phone8(x.customer_phone), $4) AS test
  FROM public.orders x
  LEFT JOIN led ON led.order_id = x.id
  WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.id IN (SELECT y.id FROM public.orders y JOIN dp ON y.mex_tracking_id = dp.tracking_id
                 UNION ALL
                 SELECT dp.order_id FROM dp WHERE dp.order_id IS NOT NULL)
),
ocl AS (
  SELECT DISTINCT ON (oh.mex_tracking_id) oh.*
  FROM oh
  WHERE oh.mex_tracking_id IN (SELECT dp.tracking_id FROM dp)
  ORDER BY oh.mex_tracking_id, oh.test, oh.created_at, oh.id
)
SELECT CASE WHEN wcl.tr IS NOT NULL THEN 'web' WHEN ow.id IS NOT NULL THEN 'order' ELSE 'mex' END AS kind,
       CASE WHEN wcl.tr IS NOT NULL THEN 'web'
            WHEN ow.id IS NOT NULL THEN public.cohort_order_source(ow.sale_source)
            ELSE 'teleshop_other' END AS source,
       CASE WHEN wcl.tr IS NOT NULL THEN CASE WHEN wcl.payment_method = 'CARD' THEN 'card' ELSE 'cod' END
            WHEN ow.id IS NOT NULL THEN coalesce(ow.sale_source_detail, 'none')
            ELSE public.cohort_parcel_split(dp.account, dp.series, dp.tracking_id, dp.sender_reference) END AS split,
       CASE WHEN wcl.tr IS NULL THEN ow.sale_source END AS sale_source,
       dp.tracking_id, dp.account, dp.series, dp.status_id,
       CASE WHEN dp.status_id = 7 THEN 'returned' WHEN dp.status_id = 2 THEN 'delivered'
            WHEN dp.status_id IN (3, 9, 13) THEN 'problem' WHEN dp.status_id = 8 THEN 'label'
            ELSE 'moving' END AS outcome,
       dp.created_at_mex, dp.delivered_at, dp.returned_at,
       dp.cod_mkd::numeric AS cod_mkd,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.created_at
            WHEN ow.id IS NOT NULL THEN ow.sale_at
            ELSE dp.created_at_mex END AS sale_at,
       CASE WHEN wcl.tr IS NULL THEN ow.id END AS order_id,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.order_number
            WHEN ow.id IS NOT NULL THEN ow.display_id
            ELSE dp.tracking_id END AS display_id,
       wcl.shop_order_id AS web_id,
       dp.phone8, dp.receiver_city, dp.receiver_name,
       CASE WHEN wcl.tr IS NULL THEN ow.sold_by_person_id END AS person_id,
       CASE WHEN wcl.tr IS NULL THEN ow.prediction_list_id END AS list_id,
       CASE WHEN wcl.tr IS NULL THEN ow.prediction_list_name END AS list_name,
       CASE WHEN wcl.tr IS NOT NULL THEN wcl.status ELSE ow.status END AS crm_status
FROM dp
LEFT JOIN wcl ON wcl.tr = dp.tracking_id
LEFT JOIN ocl ON ocl.mex_tracking_id = dp.tracking_id
LEFT JOIN LATERAL (
  SELECT oh.* FROM oh
  WHERE ocl.id IS NULL AND wcl.tr IS NULL AND dp.order_id IS NOT NULL AND oh.id = dp.order_id
  LIMIT 1
) olk ON true
CROSS JOIN LATERAL (
  SELECT CASE WHEN ocl.id IS NOT NULL THEN ocl.id ELSE olk.id END AS id,
         coalesce(ocl.display_id, olk.display_id) AS display_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sale_source ELSE olk.sale_source END AS sale_source,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sale_source_detail ELSE olk.sale_source_detail END AS sale_source_detail,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.status ELSE olk.status END AS status,
         coalesce(ocl.sale_at, olk.sale_at) AS sale_at,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.sold_by_person_id ELSE olk.sold_by_person_id END AS sold_by_person_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.prediction_list_id ELSE olk.prediction_list_id END AS prediction_list_id,
         CASE WHEN ocl.id IS NOT NULL THEN ocl.prediction_list_name ELSE olk.prediction_list_name END AS prediction_list_name,
         coalesce(ocl.test, olk.test, false) AS test
) ow
WHERE CASE WHEN wcl.tr IS NOT NULL THEN NOT wcl.test ELSE NOT ow.test END
  $pr$
  USING p_from, p_to_end, p_event, public.report_excluded_phone8s();
END;
$fn$;

COMMENT ON FUNCTION public.insights_parcel_rows(timestamptz, timestamptz, text) IS
  'One row per MEX parcel of an event (created | delivered | returned | closed = delivered ∪ returned, in the window; problem_now = status 3/9/13 now; label_now = status 8 now), each parcel once, owned as insights_cash_rows owns it (web claim → real order → MEX-only), with source / split / sale day / person / list. Test phones in no row. The delivered part = insights_cash_rows; the returned part = the MEX register less the test phones. Migration 20260941000500.';

-- ── 2. insights_returns — GET /api/insights/returns ─────────────────────────
-- { meta:{clock,granularity,money,sources,has_prev},
--   kpis:{ base:{count,value_mkd,orders,web,mex_only},        sale: the sales · returned: what finished
--          returned:{count,value_mkd,cod_mkd,parcels,orders,web,mex_only},
--          rate, paid:{count,value_mkd},
--          open:{count,value_mkd,share} (sale clock; the cohort still open),
--          problem:{count,value_mkd,rejected,attempted,problematic,orders,web,mex_only} (sale clock),
--          crm_only_returned:{count,value_mkd}   CRM "returned" with no MEX parcel
--          cancelled_after_sale / trashed_after_sale:{count,value_mkd}
--          round_trip:{parcels,return_cost_mkd,deliver_cost_mkd,loss_mkd,outbound_if_billed_mkd},
--          prev:{base,returned,value_mkd,rate} | null },
--   now:{rejected,attempted,problematic:{count,value_mkd}, oldest},
--   by_source:[{key,base,base_value_mkd,returned,value_mkd,rate,open,base_orders,base_web,
--               base_mex_only,orders,web,mex_only,splits:[{key,kind,base,returned,value_mkd,rate}]}],
--   by_account:[{key: bio_natural|natura|__none__,base,returned,value_mkd,rate}],
--   by_product:{rows:[{key,name,catalogue,sold_units,returned_units,free_units,
--               free_returned_units,rate}],others,total,mex_only:{base,returned},not_products},
--   by_city:{rows:[{key,name,name_lat,name_sq,base,returned,value_mkd,rate}],others,unknown,places},
--   by_person:{rows:[{person_id,name,base,returned,value_mkd,rate}],others,none},
--   by_list:[{list_id,name,base,returned,value_mkd,rate}],
--   by_weekday:[{dow 1=Mon..7,base,returned,rate}],
--   days_to_return:{count,median_from_sale,median_at_courier,bins:[{key,count}]},
--   reasons:[{bucket,reason,count,value_mkd}],   why the after-sale cancels were cancelled
--   repeat:{phones,returns_in_window,rows:[{phone8,name,returned_all,delivered_all,in_window,last_returned}]},
--   trend:[{d,base,returned,open,value_mkd}] }
-- "value" of a return = the COD MEX did not collect (uncollected, not a loss:
-- the goods come back). Rates are shares 0..1 (4 decimals).
CREATE OR REPLACE FUNCTION public.insights_returns(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_clock       text        DEFAULT 'sale',
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_sources     text[]      DEFAULT NULL,
  p_money       boolean     DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_gran text;
  v_lo   timestamptz;
  v_rc   numeric;
  v_dc   numeric;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_returns: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'sale') NOT IN ('sale', 'returned') THEN
    RAISE EXCEPTION 'insights_returns: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- the comparison only for windows up to 93 days (a year's would double the scan)
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_returns: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));
  -- the MEX rate card (courier_rates, EUR; MEX is the only Macedonian carrier)
  SELECT max(r.return_cost), max(r.deliver_cost) INTO v_rc, v_dc
    FROM public.courier_rates r WHERE r.courier = 'mex';

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 clock · $11 MEX return cost (EUR) · $12 MEX delivery
  -- cost (EUR) · $13 the test phones' last-8 digits
  EXECUTE $rs$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $10::text AS clock,
         round(coalesce($11::numeric, 0) * 61.5) AS rc_mkd, round(coalesce($12::numeric, 0) * 61.5) AS dc_mkd
),
-- ── the rows: ONE shape for both clocks, materialised ONCE ─────────────────
-- Sale clock: the cohort itself (insights_sale_rows) — base = the period's
-- sales, returned = the cohort's "returned" bucket, so the tab ties to the
-- cohort by construction. MEX clock: every parcel that FINISHED in the window,
-- each once — delivered (by its delivery day) or returned (status 7, by its
-- return day); the base is what finished, the returned part ties to the
-- register. The register is joined by a HASH join on purpose: nearly every
-- sale has a parcel, one scan of mex_parcels beats one index probe per sale,
-- and the planner cannot see the function's real row count (the wrapped key
-- rules the probe out). Per-row facts of the current window (city, return
-- day, weekday, trend bucket) are computed here, once.
cx AS MATERIALIZED (
  SELECT u.*,
         CASE WHEN u.cur THEN
           coalesce(nullif(btrim(u.p_city), ''),
                    CASE WHEN u.kind = 'order' THEN (SELECT nullif(btrim(o.customer_city), '') FROM public.orders o WHERE o.id = u.order_id)
                         WHEN u.kind = 'web' THEN (SELECT nullif(btrim(w.city), '') FROM public.web_orders w WHERE w.shop_order_id = u.web_id) END)
         END AS city_raw,
         coalesce(u.p_ret_at,
                  CASE WHEN u.cur AND u.ret AND u.kind = 'order' THEN
                    (SELECT coalesce(o.mex_returned_at, o.returned_at) FROM public.orders o WHERE o.id = u.order_id) END) AS ret_at,
         extract(isodow FROM (u.sale_at AT TIME ZONE 'Europe/Skopje'))::int AS dow,
         to_char(date_trunc($9, (u.ev_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM (
    SELECT v.*,
           (v.ev_at BETWEEN $1 AND $2) AS cur,
           coalesce(v.ev_at BETWEEN $3 AND $4, false) AS prev,
           (v.bucket = 'returned') AS ret
    FROM (
      SELECT r.kind, r.source, r.split, r.sale_source, r.bucket, r.in_total,
             r.value_mkd, r.cod_mkd, r.sale_at, r.sale_at AS ev_at,
             r.person_id, r.list_id, r.list_name, r.order_id, r.web_id, r.tracking_id, r.phone8,
             r.mex_status_id, r.mex_account,
             p.receiver_city AS p_city, p.returned_at AS p_ret_at, p.created_at_mex AS parcel_at
      FROM public.insights_sale_rows($6, $2, false) r
      LEFT JOIN (SELECT m.tracking_id || '' AS tr, m.receiver_city, m.returned_at, m.created_at_mex
                   FROM public.mex_parcels m) p ON p.tr = r.tracking_id
      WHERE $10 = 'sale'
        AND r.source = ANY ($5)
        AND (r.in_total OR r.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
      UNION ALL
      SELECT q.kind, q.source, q.split, q.sale_source,
             CASE WHEN q.outcome = 'returned' THEN 'returned' ELSE 'paid' END,
             true,
             greatest(coalesce(q.cod_mkd, 0), 0), q.cod_mkd, q.sale_at,
             CASE WHEN q.outcome = 'returned' THEN q.returned_at ELSE q.delivered_at END,
             q.person_id, q.list_id, q.list_name, q.order_id, q.web_id, q.tracking_id, q.phone8,
             q.status_id, q.account,
             q.receiver_city, q.returned_at, q.created_at_mex
      FROM public.insights_parcel_rows($6, $2, 'closed') q
      WHERE $10 = 'returned'
        AND q.source = ANY ($5)
    ) v
  ) u
),
-- sold, then cancelled / trashed with no parcel — OUTSIDE the total. Sale
-- clock: the cohort's own rows. MEX clock: by the day of that decision.
ox AS MATERIALIZED (
  SELECT cx.source, cx.bucket, cx.value_mkd,
         (SELECT CASE WHEN cx.bucket = 'cancelled_after_sale' THEN o.cancellation_reason ELSE o.trash_reason END
            FROM public.orders o WHERE o.id = cx.order_id) AS reason
  FROM cx
  WHERE cx.cur AND cx.bucket IN ('cancelled_after_sale', 'trashed_after_sale')
  UNION ALL
  SELECT d.source, d.bucket, d.value_mkd, d.reason
  FROM (
    SELECT public.cohort_order_source(x.sale_source) AS source,
           public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                      x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                      x.mex_cod_mkd, x.mex_delivered_at,
                                      coalesce(x.mex_tracking_id IN (SELECT w.mex_tracking_id FROM public.web_orders w
                                                                     WHERE w.mex_tracking_id IS NOT NULL
                                                                       AND w.deleted_in_shop_at IS NULL), false)) AS bucket,
           round(coalesce(x.price, 0) * 61.5) AS value_mkd,
           CASE WHEN x.status = 'cancelled' THEN x.cancellation_reason ELSE x.trash_reason END AS reason
    FROM public.orders x
    WHERE $10 = 'returned'
      AND x.status IN ('cancelled', 'trashed')
      AND x.sold_at IS NOT NULL
      AND ((x.status = 'cancelled' AND x.cancelled_at BETWEEN $1 AND $2)
           OR (x.status = 'trashed' AND x.trashed_at BETWEEN $1 AND $2))
      AND x.sale_source_detail IS DISTINCT FROM 'disposition'
      AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $13)
  ) d
  WHERE d.bucket IN ('cancelled_after_sale', 'trashed_after_sale')
    AND d.source = ANY ($5)
),
-- ── KPIs (current + previous window, one pass) ─────────────────────────────
kp AS (
  SELECT
    count(*) FILTER (WHERE r.cur AND r.in_total)                                 AS base_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.in_total), 0)            AS base_v,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'order')            AS base_o,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'web')              AS base_w,
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'mex')              AS base_m,
    count(*) FILTER (WHERE r.cur AND r.ret)                                      AS ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.ret), 0)                 AS ret_v,
    coalesce(sum(r.cod_mkd) FILTER (WHERE r.cur AND r.ret), 0)                   AS ret_c,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NOT NULL)        AS ret_parcels,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'order')                 AS ret_o,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'web')                   AS ret_w,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.kind = 'mex')                   AS ret_m,
    count(*) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NULL)            AS crm_ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.ret AND r.tracking_id IS NULL), 0) AS crm_ret_v,
    count(*) FILTER (WHERE r.cur AND r.bucket IN ('paid', 'paid_legacy', 'paid_unproven'))  AS paid_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket IN ('paid', 'paid_legacy', 'paid_unproven')), 0) AS paid_v,
    count(*) FILTER (WHERE r.cur AND r.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')) AS open_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')), 0) AS open_v,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem')               AS prob_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.cur AND r.bucket = 'courier_problem'), 0) AS prob_v,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 13) AS prob_13,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 9)  AS prob_9,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.mex_status_id = 3)  AS prob_3,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'order')     AS prob_o,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'web')       AS prob_w,
    count(*) FILTER (WHERE r.cur AND r.bucket = 'courier_problem' AND r.kind = 'mex')       AS prob_m,
    count(*) FILTER (WHERE r.prev AND r.in_total)                                AS p_base_n,
    count(*) FILTER (WHERE r.prev AND r.ret)                                     AS p_ret_n,
    coalesce(sum(r.value_mkd) FILTER (WHERE r.prev AND r.ret), 0)                AS p_ret_v
  FROM cx r
),
oa AS (
  SELECT count(*) FILTER (WHERE ox.bucket = 'cancelled_after_sale')                    AS can_n,
         coalesce(sum(ox.value_mkd) FILTER (WHERE ox.bucket = 'cancelled_after_sale'), 0) AS can_v,
         count(*) FILTER (WHERE ox.bucket = 'trashed_after_sale')                      AS tr_n,
         coalesce(sum(ox.value_mkd) FILTER (WHERE ox.bucket = 'trashed_after_sale'), 0) AS tr_v
  FROM ox
),
-- at the courier with a problem NOW (any sale day): 13 Rejected stays at the
-- courier until MEX says 7 · 9 delivery attempted · 3 problematic
nw AS (
  SELECT count(*) FILTER (WHERE q.status_id = 13)                      AS n13,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 13), 0)   AS c13,
         count(*) FILTER (WHERE q.status_id = 9)                       AS n9,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 9), 0)    AS c9,
         count(*) FILTER (WHERE q.status_id = 3)                       AS n3,
         coalesce(sum(q.cod_mkd) FILTER (WHERE q.status_id = 3), 0)    AS c3,
         min(q.created_at_mex)                                         AS oldest
  FROM public.insights_parcel_rows($1, $2, 'problem_now') q
  WHERE q.source = ANY ($5)
),
-- ── every breakdown in ONE pass (grouping sets) ────────────────────────────
-- cities: one key per place (mk_city_key — the MEX receiver city when a parcel)
ck AS MATERIALIZED (
  SELECT d.raw, public.mk_city_key(d.raw) AS k
  FROM (SELECT DISTINCT cx.city_raw AS raw FROM cx WHERE cx.cur AND cx.in_total AND cx.city_raw IS NOT NULL) d
),
ckn AS (                   -- a spelling to show for a place mk_settlements does not know
  SELECT ck.k, min(ck.raw) AS sample FROM ck WHERE ck.k IS NOT NULL GROUP BY ck.k
),
ga AS MATERIALIZED (
  SELECT CASE WHEN GROUPING(cx.split) = 0       THEN 'split'
              WHEN GROUPING(cx.source) = 0      THEN 'source'
              WHEN GROUPING(cx.mex_account) = 0 THEN 'account'
              WHEN GROUPING(ck.k) = 0           THEN 'city'
              WHEN GROUPING(cx.person_id) = 0   THEN 'person'
              WHEN GROUPING(cx.list_id) = 0     THEN 'list'
              WHEN GROUPING(cx.dow) = 0         THEN 'dow'
              ELSE 'day' END                                             AS dim,
         cx.source, cx.split, cx.kind, cx.mex_account, ck.k AS city, cx.person_id, cx.list_id, cx.dow, cx.d,
         count(*)                                                        AS base,
         coalesce(sum(cx.value_mkd), 0)                                  AS base_v,
         count(*) FILTER (WHERE cx.ret)                                  AS ret,
         coalesce(sum(cx.value_mkd) FILTER (WHERE cx.ret), 0)            AS ret_v,
         count(*) FILTER (WHERE cx.bucket IN ('courier', 'courier_problem', 'label', 'to_pack')) AS open,
         count(*) FILTER (WHERE cx.kind = 'order')                       AS bo,
         count(*) FILTER (WHERE cx.kind = 'web')                         AS bw,
         count(*) FILTER (WHERE cx.kind = 'mex')                         AS bm,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'order')            AS ro,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'web')              AS rw,
         count(*) FILTER (WHERE cx.ret AND cx.kind = 'mex')              AS rm
  FROM cx
  LEFT JOIN ck ON ck.raw = cx.city_raw
  WHERE cx.cur AND cx.in_total
  GROUP BY GROUPING SETS ((cx.source), (cx.source, cx.split, cx.kind), (cx.mex_account), (ck.k),
                          (cx.person_id, cx.kind), (cx.list_id), (cx.dow), (cx.d))
),
bsrcj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', s.source,
           'base', s.base, 'base_value_mkd', round(s.base_v),
           'returned', s.ret, 'value_mkd', round(s.ret_v),
           'rate', CASE WHEN s.base > 0 THEN round(s.ret::numeric / s.base, 4) END,
           'open', s.open,
           'base_orders', s.bo, 'base_web', s.bw, 'base_mex_only', s.bm,
           'orders', s.ro, 'web', s.rw, 'mex_only', s.rm,
           'splits', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', x.split, 'kind', x.kind, 'base', x.base, 'returned', x.ret,
                      'value_mkd', round(x.ret_v),
                      'rate', CASE WHEN x.base > 0 THEN round(x.ret::numeric / x.base, 4) END)
                    ORDER BY x.base DESC, x.split)
             FROM ga x WHERE x.dim = 'split' AND x.source = s.source), '[]'::jsonb))
         ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'], s.source)), '[]'::jsonb) AS j
  FROM ga s
  WHERE s.dim = 'source'
),
bacc AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', coalesce(a.mex_account, '__none__'), 'base', a.base, 'returned', a.ret, 'value_mkd', round(a.ret_v),
           'rate', CASE WHEN a.base > 0 THEN round(a.ret::numeric / a.base, 4) END)
         ORDER BY a.base DESC), '[]'::jsonb) AS j
  FROM ga a WHERE a.dim = 'account'
),
crank AS (
  SELECT c.*, row_number() OVER (ORDER BY c.ret DESC, c.base DESC, c.city) AS rn
  FROM ga c WHERE c.dim = 'city' AND c.city IS NOT NULL
),
cname AS (
  SELECT DISTINCT ON (s.name_norm) s.name_norm, s.name, s.name_lat, s.name_sq
  FROM public.mk_settlements s
  WHERE s.name_norm IN (SELECT crank.city FROM crank WHERE crank.rn <= 15)
  ORDER BY s.name_norm, CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
),
bcity AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', c.city, 'name', coalesce(n.name, cs.sample), 'name_lat', coalesce(n.name_lat, cs.sample),
               'name_sq', coalesce(n.name_sq, n.name_lat, cs.sample),
               'base', c.base, 'returned', c.ret, 'value_mkd', round(c.ret_v),
               'rate', CASE WHEN c.base > 0 THEN round(c.ret::numeric / c.base, 4) END)
             ORDER BY c.rn)
      FROM crank c LEFT JOIN cname n ON n.name_norm = c.city LEFT JOIN ckn cs ON cs.k = c.city
      WHERE c.rn <= 15), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('places', count(*), 'base', coalesce(sum(c.base), 0), 'returned', coalesce(sum(c.ret), 0),
                                         'value_mkd', round(coalesce(sum(c.ret_v), 0)))
               FROM crank c WHERE c.rn > 15),
    'unknown', (SELECT jsonb_build_object('base', coalesce(sum(c.base), 0), 'returned', coalesce(sum(c.ret), 0),
                                          'value_mkd', round(coalesce(sum(c.ret_v), 0)))
                FROM ga c WHERE c.dim = 'city' AND c.city IS NULL),
    'places', (SELECT count(*) FROM crank)) AS j
),
-- sellers: orders only — web-shop orders and MEX-only parcels have none
prk AS (
  SELECT p.*, row_number() OVER (ORDER BY p.ret DESC, p.base DESC, p.person_id) AS rn
  FROM ga p WHERE p.dim = 'person' AND p.kind = 'order' AND p.person_id IS NOT NULL
),
bperson AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'person_id', x.person_id, 'name', sp.display_name, 'base', x.base, 'returned', x.ret,
               'value_mkd', round(x.ret_v), 'rate', CASE WHEN x.base > 0 THEN round(x.ret::numeric / x.base, 4) END)
             ORDER BY x.rn)
      FROM prk x LEFT JOIN public.sales_people sp ON sp.id = x.person_id
      WHERE x.rn <= 20), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('people', count(*), 'base', coalesce(sum(x.base), 0), 'returned', coalesce(sum(x.ret), 0),
                                         'value_mkd', round(coalesce(sum(x.ret_v), 0)))
               FROM prk x WHERE x.rn > 20),
    'none', (SELECT jsonb_build_object('base', coalesce(sum(p.base), 0), 'returned', coalesce(sum(p.ret), 0),
                                       'value_mkd', round(coalesce(sum(p.ret_v), 0)))
             FROM ga p WHERE p.dim = 'person' AND p.kind = 'order' AND p.person_id IS NULL)) AS j
),
blist AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'list_id', l.list_id, 'name', nm.list_name,
           'base', l.base, 'returned', l.ret, 'value_mkd', round(l.ret_v),
           'rate', CASE WHEN l.base > 0 THEN round(l.ret::numeric / l.base, 4) END)
         ORDER BY l.rn), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.ret DESC, g.base DESC, g.list_id) AS rn
        FROM ga g WHERE g.dim = 'list' AND g.list_id IS NOT NULL) l
  LEFT JOIN (SELECT cx.list_id, max(cx.list_name) AS list_name FROM cx
              WHERE cx.cur AND cx.list_id IS NOT NULL GROUP BY cx.list_id) nm ON nm.list_id = l.list_id
  WHERE l.rn <= 20
),
bdow AS (
  SELECT jsonb_agg(jsonb_build_object('dow', w.d, 'base', coalesce(a.base, 0), 'returned', coalesce(a.ret, 0),
                                      'rate', CASE WHEN coalesce(a.base, 0) > 0 THEN round(a.ret::numeric / a.base, 4) END)
                   ORDER BY w.d) AS j
  FROM generate_series(1, 7) w(d)
  LEFT JOIN ga a ON a.dim = 'dow' AND a.dow = w.d
),
-- the trend: per day (per month beyond 62 days) on the clock of the view
btrend AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d, 'base', coalesce(a.base, 0), 'returned', coalesce(a.ret, 0),
                                               'open', coalesce(a.open, 0), 'value_mkd', round(coalesce(a.ret_v, 0)))
                            ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN ga a ON a.dim = 'day' AND a.d = k.d
),
-- days from the sale to the return (MEX return day; CRM return day when no parcel)
dtr AS (
  SELECT extract(epoch FROM (cx.ret_at - cx.sale_at)) / 86400.0 AS ds,
         CASE WHEN cx.parcel_at IS NOT NULL THEN extract(epoch FROM (cx.ret_at - cx.parcel_at)) / 86400.0 END AS dc
  FROM cx WHERE cx.cur AND cx.ret AND cx.ret_at IS NOT NULL AND cx.sale_at IS NOT NULL
),
bdays AS (
  SELECT jsonb_build_object(
    'count', (SELECT count(*) FROM dtr),
    'median_from_sale', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(dtr.ds, 0))::numeric, 1) FROM dtr),
    'median_at_courier', (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY greatest(dtr.dc, 0))::numeric, 1) FROM dtr WHERE dtr.dc IS NOT NULL),
    'bins', (SELECT jsonb_agg(jsonb_build_object('key', b.key, 'count', coalesce(a.n, 0)) ORDER BY b.ord)
             FROM (VALUES ('0_3', 1), ('4_7', 2), ('8_14', 3), ('15_21', 4), ('22_30', 5), ('31_plus', 6)) b(key, ord)
             LEFT JOIN (
               SELECT CASE WHEN dtr.ds < 4 THEN '0_3' WHEN dtr.ds < 8 THEN '4_7' WHEN dtr.ds < 15 THEN '8_14'
                           WHEN dtr.ds < 22 THEN '15_21' WHEN dtr.ds < 31 THEN '22_30' ELSE '31_plus' END AS key,
                      count(*) AS n
               FROM dtr GROUP BY 1) a ON a.key = b.key)) AS j
),
-- products: the item lines (units) of the returned sales against the sold
-- units — orders' and web orders' lines; a MEX-only parcel carries no product
-- data (its own row). order_items is hash-joined for the reason given at `sr`.
ln AS MATERIALIZED (
  SELECT cx.ret, CASE WHEN cx.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM cx JOIN public.order_items i ON (i.order_id::text) = cx.order_id::text
  WHERE cx.cur AND cx.in_total AND cx.kind = 'order'
  UNION ALL
  SELECT cx.ret, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM cx JOIN public.web_order_items i ON i.shop_order_id = cx.web_id
  WHERE cx.cur AND cx.in_total AND cx.kind = 'web'
),
la AS MATERIALIZED (       -- folded per distinct line text first (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         sum(ln.q) AS q_all, coalesce(sum(ln.q) FILTER (WHERE ln.ret), 0) AS q_ret
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names (an unaliased line equal to ONE of them folds into it)
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (
  SELECT x.nm, x.q_all, x.q_ret,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
pagg AS (
  SELECT lk.key,
         coalesce(sum(lk.q_all) FILTER (WHERE lk.lkind = 'product'), 0) AS sold_u,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind = 'product'), 0) AS ret_u,
         coalesce(sum(lk.q_all) FILTER (WHERE lk.lkind = 'gift'), 0)    AS free_u,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind = 'gift'), 0)    AS free_ret_u,
         (array_agg(lk.nm ORDER BY lk.q_all DESC NULLS LAST))[1]        AS sample
  FROM lk WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
prank AS (
  SELECT p.*, row_number() OVER (ORDER BY p.ret_u DESC, p.sold_u DESC, p.key) AS rn
  FROM pagg p WHERE p.sold_u > 0 OR p.ret_u > 0
),
bprod AS (
  SELECT jsonb_build_object(
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'key', r.key, 'name', coalesce(pp.name, r.sample), 'catalogue', pp.id IS NOT NULL,
               'sold_units', r.sold_u, 'returned_units', r.ret_u, 'free_units', r.free_u, 'free_returned_units', r.free_ret_u,
               'rate', CASE WHEN r.sold_u > 0 THEN round(r.ret_u::numeric / r.sold_u, 4) END)
             ORDER BY r.rn)
      FROM prank r
      LEFT JOIN public.products pp ON r.key LIKE 'p:%' AND pp.id::text = substr(r.key, 3)
      WHERE r.rn <= 15), '[]'::jsonb),
    'others', (SELECT jsonb_build_object('products', count(*), 'sold_units', coalesce(sum(r.sold_u), 0),
                                         'returned_units', coalesce(sum(r.ret_u), 0))
               FROM prank r WHERE r.rn > 15),
    'total', (SELECT jsonb_build_object('sold_units', coalesce(sum(p.sold_u), 0), 'returned_units', coalesce(sum(p.ret_u), 0),
                                        'free_units', coalesce(sum(p.free_u), 0), 'free_returned_units', coalesce(sum(p.free_ret_u), 0))
              FROM pagg p),
    'mex_only', (SELECT jsonb_build_object('base', count(*), 'returned', count(*) FILTER (WHERE cx.ret))
                 FROM cx WHERE cx.cur AND cx.in_total AND cx.kind = 'mex'),
    'not_products', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u) ORDER BY x.u DESC, x.lkind), '[]'::jsonb)
                     FROM (SELECT lk.lkind, sum(lk.q_all) AS u FROM lk WHERE lk.lkind NOT IN ('product', 'gift') GROUP BY 1) x)) AS j
),
-- why the sales cancelled / trashed after the sale were
breason AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('bucket', x.bucket, 'reason', x.reason, 'count', x.n, 'value_mkd', round(x.v))
                            ORDER BY x.n DESC, x.reason), '[]'::jsonb) AS j
  FROM (SELECT ox.bucket, coalesce(nullif(btrim(ox.reason), ''), '__unknown__') AS reason, count(*) AS n, sum(ox.value_mkd) AS v
        FROM ox GROUP BY 1, 2) x
),
-- the same phone returning again: phones with a return in this window and at
-- least two returned MEX parcels all time (the test phones are in no row)
rph AS (
  SELECT cx.phone8, count(*) AS in_window
  FROM cx WHERE cx.cur AND cx.ret AND cx.phone8 IS NOT NULL AND length(cx.phone8) = 8
  GROUP BY cx.phone8
),
rall AS MATERIALIZED (
  SELECT p.phone8, max(rph.in_window) AS in_window,
         count(*) FILTER (WHERE p.status_id = 7) AS ret_all,
         count(*) FILTER (WHERE p.status_id = 2) AS del_all,
         max(p.returned_at) AS last_ret,
         (array_agg(p.receiver_name ORDER BY p.created_at_mex DESC NULLS LAST))[1] AS name
  FROM rph
  JOIN public.mex_parcels p ON p.phone8 = rph.phone8
  GROUP BY p.phone8
  HAVING count(*) FILTER (WHERE p.status_id = 7) >= 2
),
brep AS (
  SELECT jsonb_build_object(
    'phones', (SELECT count(*) FROM rall),
    'returns_in_window', (SELECT coalesce(sum(rall.in_window), 0) FROM rall),
    'rows', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'phone8', x.phone8, 'name', x.name, 'returned_all', x.ret_all, 'delivered_all', x.del_all,
               'in_window', x.in_window, 'last_returned', to_char((x.last_ret AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
             ORDER BY x.rn)
      FROM (SELECT rall.*,
                   row_number() OVER (ORDER BY rall.ret_all DESC, rall.in_window DESC, rall.last_ret DESC, rall.phone8) AS rn
            FROM rall) x
      WHERE x.rn <= 20), '[]'::jsonb)) AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', prm.clock, 'granularity', prm.gran, 'money', true,
                             'sources', to_jsonb(prm.srcs)),
  'kpis', jsonb_build_object(
    'base', jsonb_build_object('count', kp.base_n, 'value_mkd', round(kp.base_v),
                               'orders', kp.base_o, 'web', kp.base_w, 'mex_only', kp.base_m),
    'returned', jsonb_build_object('count', kp.ret_n, 'value_mkd', round(kp.ret_v), 'cod_mkd', round(kp.ret_c),
                                   'parcels', kp.ret_parcels, 'orders', kp.ret_o, 'web', kp.ret_w, 'mex_only', kp.ret_m),
    'rate', CASE WHEN kp.base_n > 0 THEN round(kp.ret_n::numeric / kp.base_n, 4) END,
    'paid', jsonb_build_object('count', kp.paid_n, 'value_mkd', round(kp.paid_v)),
    'open', CASE WHEN prm.clock = 'sale' THEN jsonb_build_object('count', kp.open_n, 'value_mkd', round(kp.open_v),
                   'share', CASE WHEN kp.base_n > 0 THEN round(kp.open_n::numeric / kp.base_n, 4) END) END,
    'problem', CASE WHEN prm.clock = 'sale' THEN jsonb_build_object('count', kp.prob_n, 'value_mkd', round(kp.prob_v),
                   'rejected', kp.prob_13, 'attempted', kp.prob_9, 'problematic', kp.prob_3,
                   'orders', kp.prob_o, 'web', kp.prob_w, 'mex_only', kp.prob_m) END,
    'crm_only_returned', jsonb_build_object('count', kp.crm_ret_n, 'value_mkd', round(kp.crm_ret_v)),
    'cancelled_after_sale', jsonb_build_object('count', oa.can_n, 'value_mkd', round(oa.can_v)),
    'trashed_after_sale', jsonb_build_object('count', oa.tr_n, 'value_mkd', round(oa.tr_v)),
    'round_trip', jsonb_build_object('parcels', kp.ret_parcels,
                                     'return_cost_mkd', prm.rc_mkd, 'deliver_cost_mkd', prm.dc_mkd,
                                     'loss_mkd', kp.ret_parcels * prm.rc_mkd,
                                     'outbound_if_billed_mkd', kp.ret_parcels * prm.dc_mkd),
    'prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE jsonb_build_object(
              'base', kp.p_base_n, 'returned', kp.p_ret_n, 'value_mkd', round(kp.p_ret_v),
              'rate', CASE WHEN kp.p_base_n > 0 THEN round(kp.p_ret_n::numeric / kp.p_base_n, 4) END) END),
  'now', jsonb_build_object(
    'rejected', jsonb_build_object('count', nw.n13, 'value_mkd', round(nw.c13)),
    'attempted', jsonb_build_object('count', nw.n9, 'value_mkd', round(nw.c9)),
    'problematic', jsonb_build_object('count', nw.n3, 'value_mkd', round(nw.c3)),
    'oldest', to_char((nw.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD')),
  'by_source', (SELECT j FROM bsrcj),
  'by_account', (SELECT j FROM bacc),
  'by_product', (SELECT j FROM bprod),
  'by_city', (SELECT j FROM bcity),
  'by_person', (SELECT j FROM bperson),
  'by_list', (SELECT j FROM blist),
  'by_weekday', (SELECT j FROM bdow),
  'days_to_return', (SELECT j FROM bdays),
  'reasons', (SELECT j FROM breason),
  'repeat', (SELECT j FROM brep),
  'trend', (SELECT j FROM btrend))
FROM prm, kp, oa, nw
  $rs$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran, coalesce(p_clock, 'sale'),
        v_rc, v_dc, public.report_excluded_phone8s();

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.insights_returns(timestamptz, timestamptz, text, timestamptz, timestamptz, text[], boolean) IS
  'GET /api/insights/returns (owner rules 2026-09-28): returns on two clocks — sale (the cohort: the period''s sales and how many came back so far; ties to insights_cohort''s returned bucket) and returned (MEX return day: parcels MEX returned in the period against every parcel that finished in it; ties to the register). KPIs, still-open share, problems at the courier now, cancelled/trashed after sale, round-trip loss from courier_rates, and breakdowns by source/split, MEX account, product (units), city, seller, list, weekday, days to return, repeat returners, trend. p_money = false strips every *_mkd key. Migration 20260941000500.';

-- ── 3. insights_stock — GET /api/insights/stock ─────────────────────────────
-- { meta:{clock:'sale',granularity,money,sources,today,has_prev},
--   trust:{trusted,last_count,last_restock,last_deduction,last_movement,last_parcel,
--          parcels_since_deduction,ledger_out_window,ledger_in_window,ledger_moves_window,parcels_window},
--   kpis:{sales,sales_mex_only,units,units_prev,free_units,units_catalogue,products_sold,
--         returned_units,returned_parcels,returned_mex_only,tracked,active,out?,low?},
--   queue:[{stage: to_pack|label,count,value_mkd,orders,web,mex_only,oldest,units,
--           ages:[{key 0_2|3_7|8_14|15_30|31_plus,count,value_mkd,orders,web,mex_only,from,to}],
--           by_source:[{key,count,value_mkd,orders,web,mex_only,oldest}]}],
--   queue_products:[{key,name,catalogue,pack_units,label_units,on_hand}],
--   products:[{key,product_id,name,sku,catalogue,tracked,placeholder,state,on_hand,low_threshold,
--              cost_known,units,units_prev,by_source:{…},free_units,returned_units,queue_units,
--              pack_units,label_units,days_cover,cost_mkd,price_mkd,stock_value_mkd}],
--   products_more:{products,units},
--   trend:[{d,units,by_source:{…}}],
--   hygiene:{duplicates:[{key,products:[…]}],unmapped:{names,units,rows},no_cost:{active,selling,units,rows},
--            not_products:[{kind,units,lines}],not_tracked,placeholder,inactive_selling},
--   valuation:{cost_mkd,price_mkd,coverage} | null (owners, and only when trusted) }
-- `out` / `low` / days_cover / stock_value are sent only when the count is
-- trusted. state: ok | low | out (tracked) · not_tracked · null (not in the catalogue).
CREATE OR REPLACE FUNCTION public.insights_stock(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_sources     text[]      DEFAULT NULL,
  p_money       boolean     DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_stock: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_stock: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 the test phones' last-8 digits · $11 today (Skopje)
  EXECUTE $st$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $11::date AS today,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- ── what moved: the cohort's sales (sale day), what came back (MEX return
-- day) and what waits in the warehouse NOW ─────────────────────────────────
sr AS MATERIALIZED (       -- the period's sales (+ the previous period's, for the movers)
  SELECT r.kind, r.source, r.sale_source, r.order_id, r.web_id,
         (r.sale_at BETWEEN $1 AND $2) AS cur,
         coalesce(r.sale_at BETWEEN $3 AND $4, false) AS prev,
         to_char(date_trunc($9, (r.sale_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM public.insights_sale_rows($6, $2, false) r
  WHERE r.in_total AND r.source = ANY ($5)
),
rt AS MATERIALIZED (       -- parcels MEX returned in the period (goods back on the shelf)
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id
  FROM public.insights_parcel_rows($1, $2, 'returned') q
  WHERE q.source = ANY ($5)
),
lb AS MATERIALIZED (       -- label printed, waiting for the courier NOW (MEX 8) — each parcel once
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id, q.sale_at, q.cod_mkd AS value_mkd
  FROM public.insights_parcel_rows($1, $2, 'label_now') q
  WHERE q.source = ANY ($5) AND coalesce(q.cod_mkd, 0) > 0
),
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win — the cohort's rule)
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($10)
),
tk AS MATERIALIZED (       -- to pack NOW: sold, no parcel yet (the cohort's to_pack bucket)
  SELECT 'order'::text AS kind, public.cohort_order_source(x.sale_source) AS source, x.sale_source,
         x.id AS order_id, NULL::integer AS web_id,
         coalesce(x.sold_at,
                  (SELECT max(l.decided_at) FROM public.altercpa_leads l
                    WHERE x.sold_at IS NULL AND l.order_id = x.id
                      AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL),
                  x.confirmed_at, x.created_at) AS sale_at,
         round(coalesce(x.price, 0) * 61.5) AS value_mkd
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                   x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                   x.mex_cod_mkd, x.mex_delivered_at,
                                   coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) = 'to_pack'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $10)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
    AND public.cohort_order_source(x.sale_source) = ANY ($5)
  UNION ALL
  SELECT 'web', 'web', NULL, NULL, w.shop_order_id, w.created_at, round(w.total)
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL
    AND w.mex_tracking_id IS NULL
    AND coalesce(w.total, 0) > 0
    AND w.created_at > $11::timestamp - interval '400 days'
    AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) = 'preparing'
    AND NOT public.insights_excluded8(w.phone8, $10)
    AND 'web' = ANY ($5)
),
qu AS (                    -- the queue: to pack + label printed, with the age of the sale
  SELECT x.*, ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) AS age,
         CASE WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 2 THEN '0_2'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 7 THEN '3_7'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 14 THEN '8_14'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 30 THEN '15_30'
              ELSE '31_plus' END AS age_key
  FROM (SELECT tk.*, 'to_pack'::text AS stage FROM tk
        UNION ALL
        SELECT lb.kind, lb.source, lb.sale_source, lb.order_id, lb.web_id, lb.sale_at, lb.value_mkd, 'label' FROM lb) x
),
-- ── every item line, once per (lset, flags) ─────────────────────────────────
-- lset: sold (cur / prev, day, source) · returned · to_pack · label. A line is
-- keyed by its text (src, product id, name, web kind, free, impossible qty).
ln AS MATERIALIZED (
  SELECT u.lset, u.cur, u.prev, u.d, u.source,
         CASE WHEN u.kind = 'web' THEN 'web' WHEN u.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.kind, sr.sale_source, sr.order_id FROM sr WHERE sr.kind = 'order'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.kind, rt.sale_source, rt.order_id FROM rt WHERE rt.kind = 'order'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.kind, qu.sale_source, qu.order_id FROM qu WHERE qu.kind = 'order') u
  -- a HASH join on purpose (all of a year's lines; see insights_returns)
  JOIN public.order_items i ON (i.order_id::text) = u.order_id::text
  UNION ALL
  SELECT u.lset, u.cur, u.prev, u.d, u.source, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.web_id FROM sr WHERE sr.kind = 'web'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.web_id FROM rt WHERE rt.kind = 'web'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.web_id FROM qu WHERE qu.kind = 'web') u
  JOIN public.web_order_items i ON i.shop_order_id = u.web_id
),
la AS MATERIALIZED (       -- folded per distinct line text (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur), 0)                              AS q_cur,
         count(*) FILTER (WHERE ln.lset = 'sold' AND ln.cur)                                            AS n_cur,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.prev), 0)                             AS q_prev,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'altercpa'), 0)   AS q_alt,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'elyon_crm'), 0)  AS q_ely,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'web'), 0)        AS q_web,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_other'), 0) AS q_tel,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'returned'), 0)                                     AS q_ret,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'to_pack'), 0)                                      AS q_pack,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'label'), 0)                                        AS q_label
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names: an unaliased line equal to ONE of them folds into it
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (       -- each line text: its product key and kind, computed ONCE
  SELECT x.*,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
-- a line's kind by its text key, as ONE jsonb object (a lookup, not a join)
lmap AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(lk.lkey, lk.lkind), '{}'::jsonb) AS m FROM lk
),
pg AS MATERIALIZED (       -- per product key: products and gifts (the rest is not a product)
  SELECT lk.key,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'product'), 0)   AS units,
         coalesce(sum(lk.q_prev) FILTER (WHERE lk.lkind = 'product'), 0)  AS units_prev,
         coalesce(sum(lk.q_alt) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_alt,
         coalesce(sum(lk.q_ely) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_ely,
         coalesce(sum(lk.q_web) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_web,
         coalesce(sum(lk.q_tel) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_tel,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'gift'), 0)      AS free_units,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)   AS returned_units,
         coalesce(sum(lk.q_pack) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)  AS pack_units,
         coalesce(sum(lk.q_label) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0) AS label_units,
         (array_agg(lk.nm ORDER BY lk.q_cur DESC NULLS LAST, lk.nm))[1]   AS sample
  FROM lk
  WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
-- ── the catalogue and its ledger ───────────────────────────────────────────
lgp AS (
  SELECT l.product_id, count(*) AS n_logs,
         count(*) FILTER (WHERE l.movement_type = 'manual_adjust' OR l.reason = 'manual') AS n_adjust,
         max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync') OR l.reason IN ('manual', 'bigarena_import')) AS counted_at,
         max(l.created_at) AS moved_at
  FROM public.inventory_logs l
  GROUP BY l.product_id
),
pc AS MATERIALIZED (
  SELECT p.id, p.name, p.sku, p.is_active, p.stock_quantity, p.low_stock_threshold, p.cost_price, p.price,
         (coalesce(g.n_logs, 0) > 0 OR coalesce(p.stock_quantity, 0) <> 0) AS tracked,
         (p.stock_quantity = 1000 AND g.n_logs = g.n_adjust AND g.n_adjust > 0) AS placeholder,
         (coalesce(p.cost_price, 0) > 0) AS cost_known,
         g.counted_at, g.moved_at,
         -- a duplicate candidate key: the first word, transliterated (Adenofrin · ADENOFRIN 20/1 cps)
         CASE WHEN length(public.mk_geo_norm(split_part(btrim(p.name), ' ', 1))) >= 4
              THEN public.mk_geo_norm(split_part(btrim(p.name), ' ', 1)) END AS dup_key
  FROM public.products p
  LEFT JOIN lgp g ON g.product_id = p.id
),
lg AS (
  SELECT max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync') OR l.reason IN ('manual', 'bigarena_import')) AS last_count_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'restock' OR l.reason = 'restock')                                               AS last_restock_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'order_deduction' OR l.reason = 'order_deduction')                               AS last_deduction_at,
         max(l.created_at)                                                                                                                  AS last_move_at,
         coalesce(-sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount < 0), 0) AS out_window,
         coalesce(sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount > 0), 0)  AS in_window,
         count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2)                                                  AS moves_window
  FROM public.inventory_logs l
),
ps AS (                    -- MEX parcels created: in the period, and since the ledger's last deduction
  SELECT count(*) FILTER (WHERE p.created_at_mex BETWEEN $1 AND $2)                      AS in_window,
         count(*) FILTER (WHERE p.created_at_mex > coalesce(lg.last_deduction_at, '-infinity')) AS since_deduction,
         max(p.created_at_mex)                                                           AS last_parcel_at
  FROM lg
  JOIN public.mex_parcels p ON p.created_at_mex >= least($1, coalesce(lg.last_deduction_at, $1))
  WHERE NOT public.insights_excluded8(p.phone8, $10)
),
tr AS (                    -- is the stock count worth reading? the ledger follows the shipments, and it was counted
  SELECT (lg.last_count_at IS NOT NULL
          AND coalesce(lg.last_deduction_at >= ps.last_parcel_at - interval '3 days', ps.last_parcel_at IS NULL)) AS trusted,
         lg.*, ps.in_window AS parcels_window, ps.since_deduction, ps.last_parcel_at
  FROM lg, ps
),
-- ── the product table ──────────────────────────────────────────────────────
pr0 AS (
  SELECT coalesce(g.key, 'p:' || c.id::text) AS key, c.id AS product_id,
         coalesce(c.name, g.sample) AS name, c.sku, c.is_active, (c.id IS NOT NULL) AS catalogue,
         coalesce(c.tracked, false) AS tracked, coalesce(c.placeholder, false) AS placeholder,
         CASE WHEN c.tracked THEN c.stock_quantity END AS on_hand,
         c.low_stock_threshold, c.cost_known, c.cost_price, c.price, c.counted_at,
         coalesce(g.units, 0) AS units, coalesce(g.units_prev, 0) AS units_prev,
         coalesce(g.u_alt, 0) AS u_alt, coalesce(g.u_ely, 0) AS u_ely, coalesce(g.u_web, 0) AS u_web, coalesce(g.u_tel, 0) AS u_tel,
         coalesce(g.free_units, 0) AS free_units, coalesce(g.returned_units, 0) AS returned_units,
         coalesce(g.pack_units, 0) AS pack_units, coalesce(g.label_units, 0) AS label_units
  FROM pg g
  -- every active catalogue product, plus any inactive one that still sold
  FULL JOIN (SELECT * FROM pc
              WHERE pc.is_active OR 'p:' || pc.id::text IN (SELECT pg.key FROM pg WHERE pg.key LIKE 'p:%')) c
         ON g.key = 'p:' || c.id::text
),
pr1 AS (
  SELECT pr0.*,
         CASE WHEN NOT pr0.catalogue THEN NULL
              WHEN NOT pr0.tracked THEN 'not_tracked'
              WHEN pr0.on_hand <= 0 THEN 'out'
              WHEN pr0.on_hand < coalesce(pr0.low_stock_threshold, 0) THEN 'low'
              ELSE 'ok' END AS state,
         row_number() OVER (ORDER BY pr0.units DESC, pr0.pack_units + pr0.label_units DESC, pr0.name) AS rn
  FROM pr0
),
prj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', p.key, 'product_id', p.product_id, 'name', p.name, 'sku', p.sku,
           'catalogue', p.catalogue, 'tracked', p.tracked, 'placeholder', p.placeholder, 'state', p.state,
           'on_hand', p.on_hand, 'low_threshold', p.low_stock_threshold, 'cost_known', p.cost_known,
           'units', p.units, 'units_prev', CASE WHEN tr0.pf IS NULL THEN NULL ELSE p.units_prev END,
           'by_source', jsonb_build_object('altercpa', p.u_alt, 'elyon_crm', p.u_ely, 'web', p.u_web, 'teleshop_other', p.u_tel),
           'free_units', p.free_units, 'returned_units', p.returned_units,
           'queue_units', p.pack_units + p.label_units, 'pack_units', p.pack_units, 'label_units', p.label_units,
           'days_cover', CASE WHEN tr0.trusted AND p.tracked AND p.units > 0 AND p.on_hand IS NOT NULL
                              THEN round(p.on_hand / (p.units::numeric / tr0.days), 1) END,
           'cost_mkd', CASE WHEN p.cost_known THEN round(p.cost_price * 61.5) END,
           'price_mkd', CASE WHEN p.price > 0 THEN round(p.price * 61.5) END,
           'stock_value_mkd', CASE WHEN tr0.trusted AND p.tracked AND p.cost_known AND p.on_hand > 0
                                   THEN round(p.on_hand * p.cost_price * 61.5) END)
         ORDER BY p.rn), '[]'::jsonb) AS j
  FROM pr1 p
  CROSS JOIN (SELECT tr.trusted, prm.pf, (prm.td - prm.fd + 1) AS days FROM tr, prm) tr0
  -- every catalogue product, and the rest (names not in the catalogue) up to 120 rows
  WHERE p.catalogue OR p.rn <= 120
),
prx AS (                   -- what the 120-row cut left out
  SELECT count(*) AS products, coalesce(sum(p.units), 0) AS units
  FROM pr1 p WHERE NOT p.catalogue AND p.rn > 120
),
-- ── KPIs ───────────────────────────────────────────────────────────────────
kp AS (
  SELECT (SELECT count(*) FROM sr WHERE sr.cur)                          AS sales,
         (SELECT count(*) FROM sr WHERE sr.cur AND sr.kind = 'mex')      AS sales_mex_only,
         (SELECT count(*) FROM sr WHERE sr.prev)                         AS sales_prev,
         (SELECT coalesce(sum(g.units), 0) FROM pg g)                    AS units,
         (SELECT coalesce(sum(g.units_prev), 0) FROM pg g)               AS units_prev,
         (SELECT coalesce(sum(g.free_units), 0) FROM pg g)               AS free_units,
         (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'p:%') AS units_catalogue,
         (SELECT count(*) FROM pg g WHERE g.units > 0)                   AS products_sold,
         (SELECT coalesce(sum(g.returned_units), 0) FROM pg g)           AS returned_units,
         (SELECT count(*) FROM rt)                                       AS returned_parcels,
         (SELECT count(*) FROM rt WHERE rt.kind = 'mex')                 AS returned_mex_only
),
-- ── the queue ──────────────────────────────────────────────────────────────
qa AS (
  SELECT qu.stage, qu.age_key, qu.source,
         count(*) AS n, coalesce(sum(qu.value_mkd), 0) AS v,
         count(*) FILTER (WHERE qu.kind = 'order') AS n_o, count(*) FILTER (WHERE qu.kind = 'web') AS n_w,
         count(*) FILTER (WHERE qu.kind = 'mex') AS n_m,
         min(qu.sale_at) AS oldest, max(qu.age) AS max_age, min(qu.age) AS min_age
  FROM qu
  GROUP BY GROUPING SETS ((qu.stage, qu.age_key), (qu.stage, qu.source), (qu.stage))
),
qj AS (
  SELECT jsonb_agg(jsonb_build_object(
           'stage', s.stage,
           'count', coalesce(t.n, 0), 'value_mkd', round(coalesce(t.v, 0)),
           'orders', coalesce(t.n_o, 0), 'web', coalesce(t.n_w, 0), 'mex_only', coalesce(t.n_m, 0),
           'oldest', to_char((t.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
           'units', (SELECT coalesce(sum(CASE WHEN s.stage = 'to_pack' THEN g.pack_units ELSE g.label_units END), 0) FROM pg g),
           'ages', (SELECT jsonb_agg(jsonb_build_object(
                             'key', a.key, 'count', coalesce(x.n, 0), 'value_mkd', round(coalesce(x.v, 0)),
                             'orders', coalesce(x.n_o, 0), 'web', coalesce(x.n_w, 0), 'mex_only', coalesce(x.n_m, 0),
                             -- the sale days this age covers (for the /orders drill)
                             'from', to_char(CASE WHEN a.hi IS NULL THEN ($11::date - coalesce(x.max_age, a.lo)) ELSE $11::date - a.hi END, 'YYYY-MM-DD'),
                             'to', to_char($11::date - a.lo, 'YYYY-MM-DD'))
                           ORDER BY a.ord)
                    FROM (VALUES ('0_2', 0, 2, 1), ('3_7', 3, 7, 2), ('8_14', 8, 14, 3), ('15_30', 15, 30, 4), ('31_plus', 31, NULL, 5)) a(key, lo, hi, ord)
                    LEFT JOIN qa x ON x.stage = s.stage AND x.age_key = a.key AND x.source IS NULL),
           'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n, 'value_mkd', round(x.v),
                                                                    'orders', x.n_o, 'web', x.n_w, 'mex_only', x.n_m,
                                                                    'oldest', to_char((x.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
                                                   ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'], x.source)), '[]'::jsonb)
                         FROM qa x WHERE x.stage = s.stage AND x.source IS NOT NULL AND x.age_key IS NULL))
         ORDER BY s.ord) AS j
  FROM (VALUES ('to_pack', 1), ('label', 2)) s(stage, ord)
  LEFT JOIN qa t ON t.stage = s.stage AND t.age_key IS NULL AND t.source IS NULL
),
-- the products waiting in the queue (units)
qp AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'name', coalesce(c.name, x.sample), 'catalogue', c.id IS NOT NULL,
                                               'pack_units', x.pack_units, 'label_units', x.label_units,
                                               'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END)
                            ORDER BY x.pack_units + x.label_units DESC, x.key), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.pack_units + g.label_units DESC, g.key) AS rn
          FROM pg g WHERE g.pack_units + g.label_units > 0) x
  LEFT JOIN pc c ON x.key = 'p:' || c.id::text
  WHERE x.rn <= 20
),
-- ── the trend: product units per day (per month beyond 62 days), by source ──
lt AS (
  SELECT ln.d, ln.source,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         sum(ln.q) AS q
  FROM ln WHERE ln.lset = 'sold' AND ln.cur
  GROUP BY 1, 2, 3
),
tv AS (
  SELECT lt.d,
         sum(lt.q) FILTER (WHERE lt.source = 'altercpa')       AS alt,
         sum(lt.q) FILTER (WHERE lt.source = 'elyon_crm')      AS ely,
         sum(lt.q) FILTER (WHERE lt.source = 'web')            AS web,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_other') AS tel
  FROM lt
  WHERE (SELECT lmap.m FROM lmap) ->> lt.lkey = 'product'
  GROUP BY lt.d
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d,
           'units', coalesce(tv.alt, 0) + coalesce(tv.ely, 0) + coalesce(tv.web, 0) + coalesce(tv.tel, 0),
           'by_source', jsonb_build_object('altercpa', coalesce(tv.alt, 0), 'elyon_crm', coalesce(tv.ely, 0),
                                           'web', coalesce(tv.web, 0), 'teleshop_other', coalesce(tv.tel, 0)))
         ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN tv ON tv.d = k.d
),
-- ── catalogue hygiene ──────────────────────────────────────────────────────
hy AS (
  SELECT jsonb_build_object(
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('key', d.dup_key, 'products', d.products) ORDER BY d.units DESC, d.dup_key)
      FROM (SELECT c.dup_key, sum(coalesce(g.units, 0)) AS units,
                   jsonb_agg(jsonb_build_object('product_id', c.id, 'name', c.name, 'tracked', c.tracked,
                                                'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END,
                                                'units', coalesce(g.units, 0))
                             ORDER BY coalesce(g.units, 0) DESC, c.name) AS products
            FROM pc c LEFT JOIN pg g ON g.key = 'p:' || c.id::text
            WHERE c.is_active AND c.dup_key IS NOT NULL
            GROUP BY c.dup_key HAVING count(*) > 1) d), '[]'::jsonb),
    'unmapped', jsonb_build_object(
      'names', (SELECT count(*) FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'n:%'),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.sample, 'units', x.units) ORDER BY x.units DESC, x.sample)
                          FROM (SELECT g.sample, g.units FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0
                                 ORDER BY g.units DESC, g.sample LIMIT 25) x), '[]'::jsonb)),
    'no_cost', jsonb_build_object(
      'active', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.cost_known),
      'selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'units', x.units) ORDER BY x.units DESC, x.name)
                          FROM (SELECT c.id, c.name, g.units FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text
                                 WHERE NOT c.cost_known AND g.units > 0 ORDER BY g.units DESC, c.name LIMIT 15) x), '[]'::jsonb)),
    'not_products', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u, 'lines', x.n) ORDER BY x.u DESC)
                                FROM (SELECT lk.lkind, sum(lk.q_cur) AS u, sum(lk.n_cur) AS n FROM lk
                                       WHERE lk.lkind NOT IN ('product', 'gift') AND lk.n_cur > 0 GROUP BY 1) x), '[]'::jsonb),
    'not_tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.tracked),
    'placeholder', (SELECT count(*) FROM pc c WHERE c.is_active AND c.placeholder),
    'inactive_selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.is_active AND g.units > 0)) AS j
),
-- ── valuation (owners; only when the count can be trusted) ─────────────────
va AS (
  SELECT round(coalesce(sum(c.stock_quantity * c.cost_price) FILTER (WHERE c.cost_known AND c.stock_quantity > 0), 0) * 61.5) AS cost_v,
         round(coalesce(sum(c.stock_quantity * c.price) FILTER (WHERE c.price > 0 AND c.stock_quantity > 0), 0) * 61.5) AS price_v,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0), 0) AS units_on_hand,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0 AND c.cost_known), 0) AS units_costed
  FROM pc c WHERE c.is_active AND c.tracked
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', 'sale', 'granularity', prm.gran, 'money', true, 'sources', to_jsonb(prm.srcs),
                             'today', to_char(prm.today, 'YYYY-MM-DD')),
  'trust', jsonb_build_object(
    'trusted', tr.trusted,
    'last_count', to_char((tr.last_count_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_restock', to_char((tr.last_restock_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_deduction', to_char((tr.last_deduction_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_movement', to_char((tr.last_move_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_parcel', to_char((tr.last_parcel_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'parcels_since_deduction', tr.since_deduction,
    'ledger_out_window', tr.out_window, 'ledger_in_window', tr.in_window, 'ledger_moves_window', tr.moves_window,
    'parcels_window', tr.parcels_window),
  'kpis', jsonb_build_object(
    'sales', kp.sales, 'sales_mex_only', kp.sales_mex_only,
    'units', kp.units, 'units_prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE kp.units_prev END,
    'free_units', kp.free_units, 'units_catalogue', kp.units_catalogue, 'products_sold', kp.products_sold,
    'returned_units', kp.returned_units, 'returned_parcels', kp.returned_parcels, 'returned_mex_only', kp.returned_mex_only,
    'tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked),
    'active', (SELECT count(*) FROM pc c WHERE c.is_active),
    'out', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity <= 0) END,
    'low', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity > 0
                                                                   AND c.stock_quantity < coalesce(c.low_stock_threshold, 0)) END),
  'queue', (SELECT j FROM qj),
  'queue_products', (SELECT j FROM qp),
  'products', (SELECT j FROM prj),
  'products_more', (SELECT jsonb_build_object('products', prx.products, 'units', prx.units) FROM prx),
  'trend', (SELECT j FROM tj),
  'hygiene', (SELECT j FROM hy),
  'valuation', CASE WHEN tr.trusted THEN (
    SELECT jsonb_build_object('cost_mkd', va.cost_v, 'price_mkd', va.price_v,
                              'coverage', CASE WHEN va.units_on_hand > 0 THEN round(va.units_costed::numeric / va.units_on_hand, 4) END)
    FROM va) END)
FROM prm, tr, kp
  $st$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran,
        public.report_excluded_phone8s(), (now() AT TIME ZONE 'Europe/Skopje')::date;

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(jsonb_set(v_out, '{valuation}', 'null'::jsonb));
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean) IS
  'GET /api/insights/stock (owner rules 2026-09-28): units sold per product (the cohort''s item lines, product_key folded, by source, trend; non-products and impossible quantities apart), units MEX returned in the period, the warehouse queue NOW (to pack / label printed, by age, per product), stock on hand only for tracked products with a trust verdict (counted + the ledger follows the shipments — days of cover and valuation only when trusted), catalogue hygiene, valuation (owners). p_money = false strips every *_mkd key and the valuation. Migration 20260941000500.';

-- ── 4. Grants ───────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.insights_parcel_rows(timestamptz, timestamptz, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_returns(timestamptz, timestamptz, text, timestamptz, timestamptz, text[], boolean)
                                                                                     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                     FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_parcel_rows(timestamptz, timestamptz, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_returns(timestamptz, timestamptz, text, timestamptz, timestamptz, text[], boolean)
                                                                                     TO service_role;
GRANT EXECUTE ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                     TO service_role;

-- The read-only verification harness (scripts/verify-tab-returns.mjs) calls
-- these with read_only: true, as supabase_read_only_user (pg_read_all_data —
-- EXECUTE on read-only functions widens nothing). Conditional for a fresh
-- local database without the platform role.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_parcel_rows(timestamptz, timestamptz, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_returns(timestamptz, timestamptz, text, timestamptz, timestamptz, text[], boolean)
                                                                                     TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)
                                                                                     TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
