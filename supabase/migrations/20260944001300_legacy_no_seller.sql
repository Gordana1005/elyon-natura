-- ============================================================================
-- "LEGACY – NO SELLER": an accepted sale nobody is credited with
-- (owner, Mile, 02.10.2026 ~00:30 — seller matching; NOT applied)
--
-- WHY. After the approved seller sources (repair-seller-matching.mjs --sources login-names,canceller,
-- 271 sales) and 20260944001200, 626 real sales still have no seller that any evidence can name:
-- AlterCPA login 2720 (May 2025, not one document ties to it), the SHARED logins 3054 (Nov–Dec 2025),
-- 3060 and 3807 (April 2026), login 3455, the ambiguous phone matches, documents gone, and parcels
-- that are not the sale's own. The owner: mark them "legacy – no seller" — they must stop showing as
-- an error, nobody gets credit, and the leaderboard and insights keep showing them under "no seller".
-- (The ~143 that only the sources he did NOT approve would resolve stay plain unresolved.)
--
-- THE MARKER — the write-once stamp itself, not a new column:
--   sold_via = 'legacy_no_seller', sold_at = the sale's cohort moment (coalesce(AlterCPA approval,
--   confirmed_at, created_at) — no sale moves a day), sold_by_person_id NULL, sold_by_ext NULL.
--   Written only by scripts/repair-legacy-no-seller.mjs (repair-kit: dry run → ledger → --rollback).
-- Why this is enough for the cron and the gates, unchanged:
--   * order_decider_plan / planPageSql / stamp_order_deciders take only sold_at IS NULL — a marked sale
--     is never listed as `unresolved` and never re-stamped; their person fill needs a sold_by_ext, so
--     nothing ever fills a person in either (and the CHECK below forbids it).
--   * trg_orders_stamp_sold returns on sold_at IS NOT NULL (write-once); collabbox_credit_order credits
--     only an order whose sold_* are all NULL; sales_backstamp_orders matches on sold_by_ext — none of
--     them can credit a marked sale.
--   * the cohort's sale day = coalesce(sold_at, approval, confirmed_at, created_at) = the same moment;
--     cohort_order_bucket reads sold_at only for cancelled / trashed rows, and every marked sale is a
--     cohort sale (paid / returned / courier …) — no bucket, day or total changes.
--   * verify-attribution C13 reads v_sales_work (decisions), never orders.sold_*: unchanged.
--     verify-stamp-parity: checks 1 + 2 never see a stamped order; check 3 counts the marked ones apart
--     ("accepted: no seller") and flags one the plan could now credit.
--
-- WHAT THIS MIGRATION CHANGES (each function re-emitted from its LIVE body — md5 drift guards below;
-- one edit each, everything else byte-for-byte):
--   1. orders_sold_via_check: + 'legacy_no_seller', and only with sold_by_person_id AND sold_by_ext
--      NULL — "nobody gets credit" is a database rule, not a convention.
--   2. insights_sale_rows: q_no_seller (the data-quality "Без продавач" WARNING of the Overview /
--      Sales / Lists tabs) is false for a marked sale — it stops showing as an error. person_id stays
--      NULL: every "with / without a seller" split still counts it as no seller.
--   3. insights_work_credited: the Work tab's "no seller" warning counts q_no_seller (the same rule).
--   4. insights_people (Agents tab) and leaderboard_day_v2 (TV board): the sale stays in no_seller
--      (count, value, Σ people + no seller = the cohort) with its own reason 'legacy_no_seller' —
--      "Legacy – no seller (accepted)" — instead of 'no_decider' / 'altercpa_cancelled'.
--   5. sales_teams_unmapped (Settings → Teams → unmapped): a marked sale is not a handle to name.
-- UI: NoSellerReason + the reason / hint / order-origin labels in all four locales.
--
-- LIVE (read-only, 02.10.2026 ~09:30 Skopje, 20260944001200 applied, the 271 not yet stamped):
-- the cron's unresolved list = 1.044 = 271 (approved sources) + 143 (unapproved sources only) +
-- 626 (this marker) + 4 replacement parcels (COD 0 — not cohort sales; left alone).
-- After the three applies the cron's unresolved list is 147 (143 + 4).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 0. drift guards: each body below was re-emitted from the live function on 02.10.2026; refuse if
--      one changed since (a re-run after this migration passes: the body then carries the marker) ──
DO $guard$
DECLARE
  r record;
  v_md5 text;
  v_has boolean;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', '40301048c57be0f2314cfc4077ba08e3'),
      ('public.insights_work_credited(timestamp with time zone,timestamp with time zone,uuid)', '9a240b7c367aced4aff17c80a795c7da'),
      ('public.insights_people(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)', '9b58ced2efcbf7d8ac23f8cad04c0ad9'),
      ('public.leaderboard_day_v2(date,text,text)', '68ef32a711dea9190d225913367c1c37'),
      ('public.sales_teams_unmapped(integer)', 'e48ed7ea8dc7138a4fad23b5948f46cc')
    ) AS v(sig, md5)
  LOOP
    SELECT md5(p.prosrc), position('legacy_no_seller' in p.prosrc) > 0 INTO v_md5, v_has
      FROM pg_proc p WHERE p.oid = to_regprocedure(r.sig);
    IF v_md5 IS NULL THEN
      RAISE EXCEPTION 'legacy_no_seller: % does not exist', r.sig;
    END IF;
    IF v_md5 IS DISTINCT FROM r.md5 AND NOT v_has THEN
      RAISE EXCEPTION 'legacy_no_seller: % changed since 02.10.2026 (md5 %) — re-emit this migration from the live body', r.sig, v_md5;
    END IF;
  END LOOP;
END
$guard$;

-- ── 1. the marker is a sold_via value, and it never names anybody ──────────────────────────────
-- NOT VALID + VALIDATE: the scan runs once, on a constraint every existing row already meets
-- (no row carries 'legacy_no_seller' before scripts/repair-legacy-no-seller.mjs --apply).
ALTER TABLE public.orders
  DROP CONSTRAINT IF EXISTS orders_sold_via_check,
  ADD CONSTRAINT orders_sold_via_check CHECK (
    sold_via IS NULL
    OR sold_via IN ('crm', 'altercpa', 'crm_push', 'collabbox', 'import')
    OR (sold_via = 'legacy_no_seller' AND sold_by_person_id IS NULL AND sold_by_ext IS NULL)) NOT VALID;
ALTER TABLE public.orders VALIDATE CONSTRAINT orders_sold_via_check;

COMMENT ON COLUMN public.orders.sold_via IS
  'Where the sale decision was taken: crm (a CRM user) · crm_push (a CRM decision pushed to AlterCPA; AlterCPA''s approval is its mirror) · altercpa (their operator, in their panel) · collabbox (the collabBox document author) · import (the 2026-08 history import) · legacy_no_seller (owner 02.10.2026: an old sale no evidence can credit — accepted with NO seller; sold_by_person_id and sold_by_ext stay NULL, CHECK orders_sold_via_check; written only by scripts/repair-legacy-no-seller.mjs).';

-- ── 2. insights_sale_rows: a marked sale is no data-quality warning (q_no_seller), still person NULL ──
CREATE OR REPLACE FUNCTION public.insights_sale_rows(p_from timestamp with time zone, p_to_end timestamp with time zone, p_keys boolean DEFAULT true)
 RETURNS TABLE(kind text, source text, split text, sale_source text, sale_at timestamp with time zone, sale_day date, bucket text, in_total boolean, proven boolean, value_eur numeric, value_mkd numeric, cod_mkd numeric, cash_at timestamp with time zone, card_mkd numeric, person_id uuid, list_id uuid, list_name text, city_key text, product_key text, crm_status text, mex_status_id integer, mex_account text, mex_series text, q_cancelled_but_moving boolean, q_no_seller boolean, q_zero_cod boolean, q_no_price boolean, q_shared_parcel boolean, q_double_count boolean, order_id uuid, display_id text, web_id integer, tracking_id text, phone8 text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- ONE definition of the rows ($1 from · $2 to_end · $3 compute the keys ·
  -- $4 the excluded phones' last-8 digits); only the last step differs: with the keys it joins the city / product
  -- keys (computed once per distinct value), without them it streams `u`
  -- straight out (no second pass, no materialisation of 100k wide rows).
  v_rows text := $sr$
WITH
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win)
  SELECT DISTINCT w.mex_tracking_id AS tr
  FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels: counted nowhere, nor is
  SELECT p.tracking_id AS tr -- any order / web order that holds one
  FROM public.mex_parcels p
  WHERE p.phone8 = ANY ($4)
),
led AS MATERIALIZED (      -- AlterCPA approvals on orders that carry no sold_at
  SELECT l.order_id, max(l.decided_at) AS decided_at
  FROM public.altercpa_leads l
  JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
  WHERE l.order_id IS NOT NULL
    AND l.decision IN ('approved', 'cancel_other')
    AND l.decided_at IS NOT NULL
  GROUP BY l.order_id
),
ob AS (
  SELECT x.id, x.display_id, x.status::text AS status, x.price, x.sale_source, x.sale_source_detail,
         x.sold_by_person_id, x.sold_via, x.prediction_list_id, x.prediction_list_name,
         x.customer_city, x.product_id, x.product_name,
         public.insights_phone8(x.customer_phone) AS p8,
         x.mex_tracking_id, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at, x.mex_account, x.dept_override,
         z.sale_at, z.web_claimed,
         (x.mex_tracking_id IS NOT NULL
          AND (x.mex_status_id IS NOT NULL OR x.mex_delivered_at IS NOT NULL)
          AND NOT z.web_claimed) AS hp,
         public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                    x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                    x.mex_cod_mkd, x.mex_delivered_at, z.web_claimed) AS bucket
  FROM public.orders x
  LEFT JOIN led ON led.order_id = x.id
  CROSS JOIN LATERAL (
    -- the ledger date counts only for an order that has no sold_at (`led`
    -- holds only those); the web claim is a hashed probe into `wc`
    SELECT coalesce(x.sold_at, led.decided_at, x.confirmed_at, x.created_at) AS sale_at,
           coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false) AS web_claimed
  ) z
  -- A superset the indexes can answer (sold_at · confirmed_at of an unsold
  -- order · created_at · a ledger date in the window); the exact sale day
  -- is checked right after.
  WHERE (x.sold_at BETWEEN $1 AND $2
         OR (x.sold_at IS NULL AND x.confirmed_at BETWEEN $1 AND $2)
         OR x.created_at BETWEEN $1 AND $2
         OR x.id = ANY (ARRAY(SELECT led.order_id FROM led WHERE led.decided_at BETWEEN $1 AND $2)))
    AND z.sale_at BETWEEN $1 AND $2
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
),
-- SHARED PARCELS (owner 2026-09-28: both orders accurate). A tracking id two
-- or more real, non-test orders hold (a web-claimed one is no order's): each
-- holder's share of the ONE COD — by price, equal shares when no holder has a
-- price — and the first-created holder takes the rounding remainder, so the
-- shares add up to the COD to the denar and the parcel is counted once.
sh0 AS MATERIALIZED (
  SELECT x.mex_tracking_id AS tr
  FROM public.orders x
  WHERE x.mex_tracking_id IS NOT NULL
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
    AND x.mex_tracking_id NOT IN (SELECT wc.tr FROM wc)
    AND x.mex_tracking_id NOT IN (SELECT tp.tr FROM tp)
  GROUP BY x.mex_tracking_id
  HAVING count(*) > 1
),
shr AS MATERIALIZED (
  SELECT s.id,
         CASE WHEN s.rn = 1 THEN s.cod - (sum(s.part) OVER (PARTITION BY s.tr) - s.part)
              ELSE s.part END AS cod_share
  FROM (
    SELECT t.*, round(t.cod * t.frac) AS part
    FROM (
      SELECT x.id, x.mex_tracking_id AS tr,
             (max(x.mex_cod_mkd) OVER w)::numeric AS cod,
             row_number() OVER (PARTITION BY x.mex_tracking_id ORDER BY x.created_at, x.id) AS rn,
             CASE WHEN sum(greatest(x.price, 0)) OVER w > 0
                  THEN greatest(x.price, 0) / sum(greatest(x.price, 0)) OVER w
                  ELSE 1.0 / count(*) OVER w END AS frac
      FROM public.orders x
      JOIN sh0 ON sh0.tr = x.mex_tracking_id
      WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
        AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)
      WINDOW w AS (PARTITION BY x.mex_tracking_id)
    ) t
  ) s
),
o AS (
  SELECT 'order'::text AS kind,
         -- the department (20260942001000): a CRM-made sale shipped on a NATURA
         -- teleshop / social series is that department's
         public.cohort_order_source(ob.sale_source, ob.sale_source_detail, ob.mex_tracking_id, ob.dept_override) AS source,
         coalesce(ob.sale_source_detail, 'none') AS split,
         ob.sale_source,
         ob.sale_at,
         ob.bucket,
         (ob.bucket = 'paid') AS proven,
         ob.price AS value_eur,
         CASE WHEN ob.bucket = 'replacement' THEN 0::numeric
              WHEN ob.hp AND sh.cod_share IS NOT NULL THEN sh.cod_share
              WHEN ob.hp AND ob.mex_cod_mkd IS NOT NULL THEN ob.mex_cod_mkd::numeric
              ELSE round(coalesce(ob.price, 0) * 61.5) END AS value_mkd,
         CASE WHEN ob.hp THEN coalesce(sh.cod_share, ob.mex_cod_mkd::numeric) END AS cod_mkd,
         -- orders.mex_delivered_at is the parcel's copy; read the register only
         -- when the copy is missing (a handful of drifted links)
         CASE WHEN ob.bucket = 'paid' THEN
           coalesce(ob.mex_delivered_at,
                    (SELECT p.delivered_at FROM public.mex_parcels p WHERE p.tracking_id = ob.mex_tracking_id)) END AS cash_at,
         NULL::numeric AS card_mkd,
         ob.sold_by_person_id AS person_id,
         ob.prediction_list_id AS list_id,
         ob.prediction_list_name AS list_name,
         -- the courier's address when there is a parcel (only read when the
         -- keys are asked for)
         coalesce(CASE WHEN $3 AND ob.hp THEN
                    (SELECT nullif(btrim(p.receiver_city), '') FROM public.mex_parcels p
                      WHERE p.tracking_id = ob.mex_tracking_id) END,
                  nullif(btrim(ob.customer_city), '')) AS city_raw,
         CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS product_src,
         ob.product_name AS product_raw,
         ob.product_id AS product_uuid,
         ob.status AS crm_status,
         CASE WHEN ob.hp THEN ob.mex_status_id END AS mex_status_id,
         CASE WHEN ob.hp THEN ob.mex_account END AS mex_account,
         -- mex_parcels.series, the same generated expression
         CASE WHEN ob.hp AND ob.mex_tracking_id ~ '^[0-9]{3}-[0-9]{4}-'
              THEN split_part(ob.mex_tracking_id, '-', 2) END AS mex_series,
         (ob.status IN ('cancelled', 'trashed') AND ob.bucket IN ('courier', 'courier_problem', 'label')) AS q_cancelled_but_moving,
         -- 02.10.2026 (owner): an accepted 'legacy_no_seller' sale is no seller, but no warning either
         (ob.sold_by_person_id IS NULL AND public.cohort_in_total(ob.bucket)
          AND ob.sold_via IS DISTINCT FROM 'legacy_no_seller') AS q_no_seller,
         (ob.bucket = 'replacement' AND ob.hp) AS q_zero_cod,
         (coalesce(ob.price, 0) <= 0 AND public.cohort_in_total(ob.bucket)) AS q_no_price,
         (ob.hp AND sh.id IS NOT NULL) AS q_shared_parcel,
         false AS q_double_count,
         ob.id AS order_id,
         ob.display_id,
         NULL::integer AS web_id,
         CASE WHEN ob.hp THEN ob.mex_tracking_id END AS tracking_id,
         CASE WHEN length(ob.p8) = 8 THEN ob.p8 END AS phone8
  FROM ob
  LEFT JOIN shr sh ON sh.id = ob.id
  WHERE ob.bucket IS NOT NULL
),
-- The shop's classifier once per distinct (status, payment) — it carries a
-- SET clause, so it is never inlined and a per-row call costs ~10 µs.
wos AS MATERIALIZED (
  SELECT d.status, d.payment_status, d.payment_method,
         public.web_order_outcome(d.status, d.payment_status, d.payment_method) AS outcome
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method
          FROM public.web_orders w
         WHERE w.deleted_in_shop_at IS NULL
           AND w.created_at BETWEEN $1 AND $2) d
),
wo AS MATERIALIZED (
  SELECT w.shop_order_id, w.order_number, w.status, w.payment_method, w.payment_status, w.total,
         w.city, w.phone8, w.is_legacy, w.created_at,
         wos.outcome,
         p.tracking_id AS p_tr, p.status_id AS p_st, p.cod_mkd AS p_cod, p.delivered_at AS p_deliv,
         p.receiver_city AS p_city, p.account AS p_account, p.series AS p_series
  FROM public.web_orders w
  JOIN wos ON wos.status = w.status AND wos.payment_status = w.payment_status
          AND wos.payment_method = w.payment_method
  LEFT JOIN public.mex_parcels p ON p.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL
    AND w.created_at BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(w.phone8, $4)
    AND NOT public.insights_excluded8(p.phone8, $4)
),
wb AS (
  SELECT wo.*, public.cohort_web_bucket(wo.outcome, wo.is_legacy, wo.total, wo.p_st, wo.p_tr IS NOT NULL) AS bucket
  FROM wo
),
wr AS (
  SELECT 'web'::text AS kind,
         'web'::text AS source,
         -- card money never passes through MEX (its COD is 0): its own split
         CASE WHEN wb.payment_method = 'CARD' THEN 'card' ELSE 'cod' END AS split,
         NULL::text AS sale_source,
         wb.created_at AS sale_at,
         wb.bucket,
         (wb.bucket = 'paid') AS proven,
         NULL::numeric AS value_eur,
         -- whole denari, as every other value: the parts add up to the denar
         CASE WHEN wb.bucket = 'replacement' THEN 0::numeric ELSE round(wb.total) END AS value_mkd,
         CASE WHEN wb.p_tr IS NOT NULL THEN wb.p_cod::numeric END AS cod_mkd,
         CASE WHEN wb.bucket = 'paid' THEN wb.p_deliv END AS cash_at,
         CASE WHEN wb.bucket = 'paid' AND wb.payment_method = 'CARD'
                   AND wb.payment_status IN ('PAID', 'PARTIALLY_REFUNDED')
              THEN greatest(round(wb.total) - coalesce(wb.p_cod, 0), 0) END AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         coalesce(nullif(btrim(wb.p_city), ''), nullif(btrim(wb.city), '')) AS city_raw,
         'web'::text AS product_src,
         CASE WHEN $3 THEN
           (SELECT i.name FROM public.web_order_items i
             WHERE i.shop_order_id = wb.shop_order_id AND i.kind = 'SALE'
             ORDER BY i.price * i.quantity DESC, i.shop_item_id
             LIMIT 1) END AS product_raw,
         NULL::uuid AS product_uuid,
         wb.status AS crm_status,
         wb.p_st AS mex_status_id,
         wb.p_account AS mex_account,
         wb.p_series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (wb.bucket = 'replacement' AND wb.p_tr IS NOT NULL) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         false AS q_double_count,
         NULL::uuid AS order_id,
         wb.order_number AS display_id,
         wb.shop_order_id AS web_id,
         wb.p_tr AS tracking_id,
         wb.phone8
  FROM wb
  WHERE wb.bucket IS NOT NULL
),
-- collabBox BOOKINGS (owner 29.09.2026, 20260942001900): an order document
-- booked in collabBox whose MEX parcel does not exist yet is a sale NOW — "to
-- pack" (Во магацин за пакување), in its FOLDER's department, credited to its
-- author. Its parcel turns it into an order (or a MEX-only parcel), counted
-- once, never twice. Its sale day is the day the operator BOOKED it
-- (collabbox_sale_at, 20260944000600 — owner 01.10.2026; doc_at is the dispatch
-- day). It stays a booking until an order holds its parcel: a parcel MEX has
-- registered but no order holds yet (the morning batch ~07:34 → the order
-- ~07:50) neither ends the booking nor counts as MEX-only (mo below). bk is
-- every booking still waiting (the writer's 14-day wait), the window is
-- applied in bkr — mo needs the bookings of every day.
-- The ledger rows the writer (collabbox_apply_one) still
-- waits on: booked / awaiting_parcel, not vanished, no storno, not reversed, a
-- value, an ORDER type (10036 Нарачка in · 10050 Нарачка out · 10106 / 10055
-- social · 10114 LEADS-OUT; never 10111 LEADS — the shipping document of an
-- AlterCPA sale), at most 14 days old (the writer's own wait,
-- collabbox_retry_open) — and never a document an order holds or names, one
-- whose parcel an ORDER holds (that order counts), one a web order claims, or a
-- komitent the writer skips (deceased, employee, …). p8 = the customer's
-- phone as the writer finds it: the komitent card → the teleshop registry →
-- any stored card.
bk0 AS MATERIALIZED (
  SELECT b.doc_number, b.doc_at, public.collabbox_sale_at(b.doc_at, b.booked_at) AS sale_at,
         b.amount_mkd, b.goods_mkd, b.author_person_id,
         public.collabbox_name_key(b.komitent_name) AS name_key,   -- the phoneless twin (20260944000630)
         public.collabbox_department(b.doc_type_id, b.doc_number, b.author_person_id, b.doc_at) AS dep,
         coalesce(
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'),
           (SELECT t.phone8 FROM public.teleshop_import_customers t
             WHERE t.komitent_id = b.komitent_id AND t.phone8 ~ '^[0-9]{8}$'),
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.phone8 ~ '^[0-9]{8}$')) AS p8
  FROM public.collabbox_documents b
  WHERE b.doc_at >= now() - interval '14 days'
    AND b.outcome IN ('booked', 'awaiting_parcel')
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.reversed_by IS NULL
    AND b.amount_mkd > 0
    AND b.doc_type_id IN ('10036', '10050', '10106', '10055', '10114')
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.external_source = 'collabbox' AND x.external_order_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p           -- a parcel an ORDER holds
                     WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM wc WHERE wc.tr = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.collabbox_customers c
                     WHERE c.komitent_id = b.komitent_id AND c.source = 'card' AND c.skip_reason IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM public.teleshop_import_customers t
                     WHERE t.komitent_id = b.komitent_id AND t.outcome = 'skipped'
                       AND t.reason IN ('deceased', 'employee', 'company', 'operator_account', 'do_not_ship',
                                        'junk_name', 'wrong_number', 'test_name'))
),
-- … and never the collabBox COPY of a CRM / AlterCPA SALE (the writer's
-- possible_twin_crm_sale): a sale with no parcel of its own, a real product and
-- a price that fits the document (× 61,5 = its amount ± 3 ден, or its amount −
-- the 150 ден delivery, or its goods) — on the customer's phone, sold up to 14
-- days before the document (its date is the SHIPPING day: a delayed shipment is
-- booked days earlier) or 2 days after; with no phone to compare, the author's
-- own sale (a LEADS-OUT copied from the CRM sale the same agent just made) within
-- 10 minutes of the BOOKING (sale_at — the document's date is the dispatch day,
-- days later for a copy booked ahead), or from 1 day before to 2 days after the
-- booking (the writer's twin window) when the customer's name matches after the
-- script fold (collabbox_name_key, ≥ 2 words): the CRM sale's own name, or any
-- name the CRM holds on that sale's phone (20260944000630). Nor a test phone.
bk AS MATERIALIZED (
  SELECT k.*
  FROM bk0 k
  WHERE NOT public.insights_excluded8(k.p8, $4)
    AND NOT EXISTS (
      SELECT 1 FROM public.orders x
       WHERE k.p8 IS NOT NULL
         AND right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = k.p8
         AND x.external_source IS DISTINCT FROM 'collabbox'
         AND x.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         AND x.mex_tracking_id IS NULL
         AND x.price > 0
         AND NOT public.is_synthetic_product_name(x.product_name)
         AND x.sale_source_detail IS DISTINCT FROM 'disposition'
         AND (abs(round(x.price * 61.5) - k.amount_mkd) <= 3
              OR abs(round(x.price * 61.5) + 150 - k.amount_mkd) <= 3
              OR abs(round(x.price * 61.5) - round(coalesce(k.goods_mkd, k.amount_mkd))) <= 3)
         AND (x.created_at BETWEEN k.doc_at - interval '14 days' AND k.doc_at + interval '2 days'
              OR coalesce(x.sold_at, x.confirmed_at) BETWEEN k.doc_at - interval '14 days' AND k.doc_at + interval '2 days'))
    AND NOT EXISTS (
      SELECT 1 FROM public.orders x
       WHERE k.p8 IS NULL
         AND x.sold_by_person_id = k.author_person_id
         AND x.created_at BETWEEN k.sale_at - interval '1 day' AND k.sale_at + interval '2 days'
         AND (x.created_at BETWEEN k.sale_at - interval '10 minutes' AND k.sale_at + interval '10 minutes'
              OR (k.name_key IS NOT NULL
                  AND (public.collabbox_name_key(x.customer_name) = k.name_key
                       OR (right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) ~ '^[0-9]{8}$'
                           AND EXISTS (SELECT 1 FROM public.orders y
                                        WHERE right(regexp_replace(y.customer_phone, '[^0-9]', '', 'g'), 8)
                                              = right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8)
                                          AND public.collabbox_name_key(y.customer_name) = k.name_key)))))
         AND x.external_source IS DISTINCT FROM 'collabbox'
         AND x.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
         AND x.mex_tracking_id IS NULL
         AND x.price > 0
         AND NOT public.is_synthetic_product_name(x.product_name)
         AND x.sale_source_detail IS DISTINCT FROM 'disposition'
         AND (abs(round(x.price * 61.5) - k.amount_mkd) <= 3
              OR abs(round(x.price * 61.5) + 150 - k.amount_mkd) <= 3
              OR abs(round(x.price * 61.5) - round(coalesce(k.goods_mkd, k.amount_mkd))) <= 3))
),
mo AS MATERIALIZED (       -- MEX-only: no live web order, no real order holds it
  -- (a parcel a TEST order holds is that order's: counted nowhere either)
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.receiver_city, p.phone8,
         public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference) AS split
  FROM public.mex_parcels p
  WHERE p.created_at_mex BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(p.phone8, $4)
    AND NOT EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id)
    AND NOT EXISTS (SELECT 1 FROM bk WHERE bk.doc_number = p.tracking_id)   -- still its booking (20260944000600)
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.mex_tracking_id = p.tracking_id
                       AND x.sale_source_detail IS DISTINCT FROM 'disposition')
    AND (p.order_id IS NULL
         OR NOT EXISTS (SELECT 1 FROM public.orders x
                         WHERE x.id = p.order_id
                           AND x.sale_source_detail IS DISTINCT FROM 'disposition'))
),
-- CRM sales with no parcel, by phone: a MEX-only parcel on one of these phones
-- within ±21 days may be the same sale (quality item; never auto-merged).
-- The phone expression is character-for-character idx_orders_phone_last8's.
cs AS MATERIALIZED (
  SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8,
         coalesce(x.sold_at, x.confirmed_at, x.created_at) AS at
  FROM public.orders x
  WHERE x.mex_tracking_id IS NULL
    AND x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
    AND coalesce(x.price, 0) > 0
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.customer_phone IS NOT NULL
    AND coalesce(x.sold_at, x.confirmed_at, x.created_at)
        BETWEEN $1 - interval '21 days' AND $2 + interval '21 days'
),
dbl AS MATERIALIZED (
  SELECT DISTINCT mo.tracking_id
  FROM mo
  JOIN cs ON cs.p8 = mo.phone8
         AND cs.at BETWEEN mo.created_at_mex - interval '21 days' AND mo.created_at_mex + interval '21 days'
  WHERE coalesce(mo.cod_mkd, 0) > 0
),
mr AS (
  SELECT 'mex'::text AS kind,
         public.cohort_parcel_source(mo.split) AS source, -- a parcel with no order: the source its series names
         mo.split,
         NULL::text AS sale_source,
         mo.created_at_mex AS sale_at,
         public.cohort_parcel_bucket(mo.status_id, mo.cod_mkd) AS bucket,
         (mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0) AS proven,
         NULL::numeric AS value_eur,
         CASE WHEN coalesce(mo.cod_mkd, 0) > 0 THEN mo.cod_mkd::numeric ELSE 0::numeric END AS value_mkd,
         mo.cod_mkd::numeric AS cod_mkd,
         CASE WHEN mo.status_id = 2 AND coalesce(mo.cod_mkd, 0) > 0 THEN mo.delivered_at END AS cash_at,
         NULL::numeric AS card_mkd,
         NULL::uuid AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         nullif(btrim(mo.receiver_city), '') AS city_raw,
         'mex'::text AS product_src,
         NULL::text AS product_raw,
         NULL::uuid AS product_uuid,
         NULL::text AS crm_status,
         mo.status_id AS mex_status_id,
         mo.account AS mex_account,
         mo.series AS mex_series,
         false AS q_cancelled_but_moving,
         false AS q_no_seller,
         (coalesce(mo.cod_mkd, 0) <= 0) AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         (mo.tracking_id IN (SELECT dbl.tracking_id FROM dbl)) AS q_double_count,
         NULL::uuid AS order_id,
         mo.tracking_id AS display_id,
         NULL::integer AS web_id,
         mo.tracking_id,
         mo.phone8
  FROM mo
),
bkr AS (
  SELECT 'booking'::text AS kind,
         -- the folder's department: the twin of the order the document becomes
         public.cohort_order_source(bk.dep[1], bk.dep[2], bk.doc_number) AS source,
         'booked'::text AS split,
         bk.dep[1] AS sale_source,
         bk.sale_at,                                   -- the BOOKING day (20260944000600)
         'to_pack'::text AS bucket,
         false AS proven,
         NULL::numeric AS value_eur,
         round(bk.amount_mkd) AS value_mkd,            -- the document's amount, already денари
         NULL::numeric AS cod_mkd,
         NULL::timestamptz AS cash_at,
         NULL::numeric AS card_mkd,
         bk.author_person_id AS person_id,
         NULL::uuid AS list_id,
         NULL::text AS list_name,
         NULL::text AS city_raw,
         'collabbox'::text AS product_src,
         NULL::text AS product_raw,
         NULL::uuid AS product_uuid,
         NULL::text AS crm_status,
         NULL::integer AS mex_status_id,
         NULL::text AS mex_account,
         NULL::text AS mex_series,
         false AS q_cancelled_but_moving,
         (bk.author_person_id IS NULL) AS q_no_seller,
         false AS q_zero_cod,
         false AS q_no_price,
         false AS q_shared_parcel,
         false AS q_double_count,
         NULL::uuid AS order_id,
         bk.doc_number AS display_id,                  -- the DocNumber = its parcel's tracking id to be
         NULL::integer AS web_id,
         NULL::text AS tracking_id,
         bk.p8 AS phone8
  FROM bk
  WHERE bk.sale_at BETWEEN $1 AND $2
),
u AS (
  SELECT * FROM o
  UNION ALL SELECT * FROM wr
  UNION ALL SELECT * FROM mr
  UNION ALL SELECT * FROM bkr
)
$sr$;
  v_keys text := $srk$,
ck AS (                    -- city keys, once per distinct raw city
  SELECT d.raw, public.mk_city_key(d.raw) AS k
  FROM (SELECT DISTINCT u.city_raw AS raw FROM u WHERE $3 AND u.city_raw IS NOT NULL) d
),
pk AS (                    -- product keys, once per distinct line
  SELECT d.src, d.raw_k, d.pid_k, public.product_key(d.src, d.raw, d.pid) AS k
  FROM (SELECT DISTINCT u.product_src AS src, u.product_raw AS raw, u.product_uuid AS pid,
               coalesce(u.product_raw, '') AS raw_k, coalesce(u.product_uuid::text, '') AS pid_k
        FROM u WHERE $3 AND (u.product_raw IS NOT NULL OR u.product_uuid IS NOT NULL)) d
)
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, ck.k AS city_key, pk.k AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
LEFT JOIN ck ON ck.raw = u.city_raw
LEFT JOIN pk ON pk.src = u.product_src
            AND pk.raw_k = coalesce(u.product_raw, '')
            AND pk.pid_k = coalesce(u.product_uuid::text, '')
$srk$;
  v_plain text := $srn$
SELECT u.kind, u.source, u.split, u.sale_source, u.sale_at,
       (u.sale_at AT TIME ZONE 'Europe/Skopje')::date AS sale_day,
       u.bucket, public.cohort_in_total(u.bucket) AS in_total, u.proven,
       u.value_eur, u.value_mkd, u.cod_mkd, u.cash_at, u.card_mkd,
       u.person_id, u.list_id, u.list_name, NULL::text AS city_key, NULL::text AS product_key,
       u.crm_status, u.mex_status_id, u.mex_account, u.mex_series,
       u.q_cancelled_but_moving, u.q_no_seller, u.q_zero_cod, u.q_no_price, u.q_shared_parcel, u.q_double_count,
       u.order_id, u.display_id, u.web_id, u.tracking_id, u.phone8
FROM u
$srn$;
  v_excluded text[];
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sale_rows: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sale_rows: bad window' USING ERRCODE = '22023';
  END IF;

  -- the test phones: read once, a constant for the planner
  v_excluded := public.report_excluded_phone8s();
  IF coalesce(p_keys, true) THEN
    RETURN QUERY EXECUTE v_rows || v_keys USING p_from, p_to_end, true, v_excluded;
  ELSE
    RETURN QUERY EXECUTE v_rows || v_plain USING p_from, p_to_end, false, v_excluded;
  END IF;
END;
$function$;

-- ── 3. insights_work_credited: the Work tab's "no seller" warning = q_no_seller ──
CREATE OR REPLACE FUNCTION public.insights_work_credited(p_from timestamp with time zone, p_to_end timestamp with time zone, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_me   uuid;
  v_gran text;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_work_credited: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_work_credited: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_user_id IS NOT NULL THEN
    SELECT sp.id INTO v_me FROM public.sales_people sp WHERE sp.user_id = p_user_id;
  END IF;
  -- insights_work's rule: by day up to 62 Skopje days, by week beyond
  v_gran := CASE WHEN (p_to_end AT TIME ZONE 'Europe/Skopje')::date
                      - (p_from AT TIME ZONE 'Europe/Skopje')::date + 1 <= 62
                 THEN 'day' ELSE 'week' END;

  WITH r AS MATERIALIZED (
    SELECT r.person_id, r.kind, r.sale_day, r.q_no_seller
    FROM public.insights_sale_rows(p_from, p_to_end, false) r
    WHERE r.in_total
  ),
  x AS (
    SELECT r.person_id,
           CASE WHEN v_gran = 'day' THEN r.sale_day ELSE date_trunc('week', r.sale_day)::date END AS b,
           count(*) AS n
    FROM r
    WHERE r.person_id IS NOT NULL
      AND (p_user_id IS NULL OR r.person_id = v_me)
    GROUP BY 1, 2
  )
  SELECT jsonb_build_object(
           'gran',      v_gran,
           'total',     (SELECT coalesce(sum(x.n), 0) FROM x),
           -- order sales in the cohort nobody is credited with yet (the
           -- decider stamping lags AlterCPA approvals): no one's number
           'no_seller', CASE WHEN p_user_id IS NULL
                             -- 02.10.2026: q_no_seller = person NULL minus the accepted 'legacy_no_seller' sales
                             THEN (SELECT count(*) FROM r WHERE r.kind IN ('order', 'booking') AND r.q_no_seller) END,
           'rows',      (SELECT coalesce(jsonb_agg(jsonb_build_object('p', x.person_id, 'b', to_char(x.b, 'YYYY-MM-DD'), 'n', x.n)
                                                   ORDER BY x.person_id, x.b), '[]'::jsonb) FROM x))
    INTO v_out;

  RETURN v_out;
END;
$function$;

-- ── 4a. insights_people (Agents tab): the reason 'legacy_no_seller' ──
CREATE OR REPLACE FUNCTION public.insights_people(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_person uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_pf       timestamptz;
  v_pt       timestamptz;
  v_fd       date;
  v_td       date;
  v_gran     text;
  v_lo       timestamptz;
  v_presence text;
  v_stamped  timestamptz;
  v_out      jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_people: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_people: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));
  SELECT to_char(min(a.day), 'YYYY-MM-DD') INTO v_presence FROM public.agent_presence_days a;
  -- when the seller stamping last ran (20260939000300; absent → NULL)
  IF to_regclass('public.order_decider_runs') IS NOT NULL THEN
    EXECUTE 'SELECT max(r.finished_at) FROM public.order_decider_runs r' INTO v_stamped;
  END IF;

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 from day ·
  -- $6 to day · $7 person · $8 the earliest instant (prev) · $9 today
  -- (Skopje) · $10 granularity · $11 the test phones' last-8 digits ·
  -- $12 presence recorded since · $13 last seller-stamping run
  -- The EXECUTE text below is byte-identical to the body tested
  -- read-only against live data (scratchpad run-body.mjs, 2026-09-28).
  EXECUTE $pp$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::date AS fd, $6::date AS td, $7::uuid AS person, $9::date AS today, $10::text AS gran,
         CASE WHEN $10::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt
),
-- the owner's test phones: their parcels, and every order that holds one or
-- is on one (a decision on such an order is no work — insights_overview's xto)
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($11::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($11::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),
-- THE sale cohort (insights_sale_rows), current and previous window in ONE
-- scan, with what its row does not carry, for the window's order sales:
--   sold_*  why a sale has no seller (read for the unattributed orders only)
--   units   PACKAGES of a credited sale = units on its lines priced >= 1 EUR
--           (gifts, loyalty points and 0,01 EUR samples are not packages: 18k
--           of 96k units in the last year); an order with no such line is its
--           own quantity when that is a plausible 1-24, else 1 (597 x 0,05 EUR
--           is one package typed as cents). Display only: the bonus block
--           keeps its own package rule, untouched.
-- Looked up row by row through the primary keys, on purpose: a join of two
-- materialised CTEs has no statistics and was planned as a nested loop (a
-- year: 50k x 40k rows, > 100 s); and only for the rows that need it (a
-- lateral over every row costs its loop even when it finds nothing).
srr AS MATERIALIZED (
  SELECT r.kind, r.source, r.split, r.bucket, r.in_total, r.value_mkd, r.cod_mkd,
         r.sale_day, r.person_id, r.order_id, r.display_id,
         (r.sale_at BETWEEN prm.f AND prm.t)                  AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($8::timestamptz, $2::timestamptz, false) r
  CROSS JOIN prm
),
sr AS MATERIALIZED (
  -- credited order sales of the window: their packages
  SELECT r.*, NULL::timestamptz AS sold_at, NULL::text AS sold_via, NULL::text AS sold_by_ext,
         coalesce(u.units,
                  (SELECT CASE WHEN x.quantity BETWEEN 1 AND 24 THEN x.quantity ELSE 1 END
                     FROM public.orders x WHERE x.id = r.order_id), 1)::numeric AS units
  FROM srr r
  LEFT JOIN LATERAL (
    SELECT sum(oi.quantity) AS units
    FROM public.order_items oi
    WHERE oi.order_id = r.order_id AND oi.price_per_unit >= 1 AND oi.quantity > 0
    HAVING count(*) > 0) u ON true
  WHERE r.cur AND r.kind = 'order' AND r.person_id IS NOT NULL
  UNION ALL
  -- unattributed order sales of the window: their sold_* stamp
  SELECT r.*, o.sold_at, o.sold_via, o.sold_by_ext, NULL::numeric
  FROM srr r
  LEFT JOIN LATERAL (
    SELECT x.sold_at, x.sold_via, x.sold_by_ext FROM public.orders x WHERE x.id = r.order_id) o ON true
  WHERE r.cur AND r.kind = 'order' AND r.person_id IS NULL
  UNION ALL
  -- everything else (web, MEX-only, the previous window) as is
  SELECT r.*, NULL::timestamptz, NULL::text, NULL::text, NULL::numeric
  FROM srr r
  WHERE NOT (r.cur AND r.kind = 'order')
),
-- primary team memberships (at most one per person per day — EXCLUDE)
mem AS MATERIALIZED (
  SELECT m.person_id, m.team_key, m.valid_from, coalesce(m.valid_to, 'infinity'::date) AS valid_to, m.role
  FROM public.sales_team_members m
  WHERE m.is_primary
),
-- the work ledger: every human decision (CRM + AlterCPA), test orders out
vw AS MATERIALIZED (
  SELECT v.at, (v.at AT TIME ZONE 'Europe/Skopje')::date AS d, v.person_id, v.via, v.order_id,
         v.outcome, v.actor_ext,
         (v.at BETWEEN prm.f AND prm.t)                  AS cur,
         coalesce(v.at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.v_sales_work v
  CROSS JOIN prm
  WHERE v.at BETWEEN $8::timestamptz AND $2::timestamptz
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
-- time on the CRM (agent_presence_days, Skopje days; recorded since 28.09.2026)
pr AS MATERIALIZED (
  SELECT a.user_id, a.day, a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes,
         a.idle_alerts, a.first_active_at, a.last_active_at
  FROM public.agent_presence_days a
  CROSS JOIN prm
  WHERE a.day BETWEEN prm.fd AND prm.td
),
-- the live state now: insights_overview's rule, verbatim
pn AS (
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
-- ONE event table. grp = the team the person was in ON THAT DAY (primary
-- membership); with none: a teleshop sale — Телешоп – Lead in (teleshop_other)
-- or Телешоп – Lead out (teleshop_out, 20260942001000) → 'teleshop_unassigned', a
-- social-media sale → 'social_unassigned', anything else → 'none' (20260943000950:
-- 'teleshop' is a real team key now — a business line). k: s sale · w decision · p presence day · r roster.
ev AS MATERIALIZED (
  SELECT 's'::text AS k, s.person_id,
         coalesce(m.team_key, CASE s.source WHEN 'teleshop_other' THEN 'teleshop_unassigned'
                                            WHEN 'teleshop_out' THEN 'teleshop_unassigned'
                                            WHEN 'social' THEN 'social_unassigned' ELSE 'none' END) AS grp,
         s.sale_day AS d, s.cur, s.prev,
         s.source, s.bucket, s.in_total, s.value_mkd, s.cod_mkd, s.units,
         NULL::text AS outcome, NULL::text AS via, false AS pday,
         NULL::integer AS online, NULL::integer AS active, NULL::integer AS idle, NULL::integer AS brk,
         NULL::integer AS alerts, NULL::timestamptz AS first_at, NULL::timestamptz AS last_at,
         s.kind AS skind
  FROM sr s
  LEFT JOIN mem m ON m.person_id = s.person_id AND s.sale_day BETWEEN m.valid_from AND m.valid_to
  WHERE s.person_id IS NOT NULL AND (s.cur OR s.prev)
  UNION ALL
  SELECT 'w', v.person_id, coalesce(m.team_key, 'none'), v.d, v.cur, v.prev,
         NULL, NULL, NULL, NULL, NULL, NULL,
         v.outcome, v.via, (pd.user_id IS NOT NULL),
         NULL, NULL, NULL, NULL, NULL, v.at, v.at, NULL
  FROM vw v
  LEFT JOIN mem m ON m.person_id = v.person_id AND v.d BETWEEN m.valid_from AND m.valid_to
  LEFT JOIN public.sales_people sp ON sp.id = v.person_id
  LEFT JOIN pr pd ON pd.user_id = sp.user_id AND pd.day = v.d
  WHERE v.person_id IS NOT NULL
  UNION ALL
  SELECT 'p', sp.id, coalesce(m.team_key, 'none'), a.day, true, false,
         NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, false,
         a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes, a.idle_alerts,
         a.first_active_at, a.last_active_at, NULL
  FROM pr a
  JOIN public.sales_people sp ON sp.user_id = a.user_id
  LEFT JOIN mem m ON m.person_id = sp.id AND a.day BETWEEN m.valid_from AND m.valid_to
  UNION ALL
  -- the roster: everyone on a team in the window is shown, sales or not
  -- (a closed membership keeps its past days even after deactivation)
  SELECT 'r', m.person_id, m.team_key, NULL::date, true, false,
         NULL, NULL, NULL, NULL, NULL, NULL,
         NULL, NULL, false,
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM mem m
  JOIN public.sales_people sp ON sp.id = m.person_id
  CROSS JOIN prm
  WHERE m.valid_from <= prm.td AND m.valid_to >= prm.fd
    AND (sp.is_active OR m.valid_to < 'infinity'::date)
),
-- ONE pass over the events (grp × person), then the person and team rows
-- summed from those ~200 rows: a GROUPING SETS over the ~50k events ran
-- every one of the 50 aggregates three times.
ag0 AS MATERIALIZED (
  SELECT e.grp, e.person_id,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total)                                             AS sales,
         count(*) FILTER (WHERE e.k = 's' AND e.cur)                                                            AS sale_rows,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.skind = 'booking')                     AS booked,
         count(*) FILTER (WHERE e.k = 's' AND e.prev AND e.in_total)                                            AS prev_sales,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid')                                      AS b_paid,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid_legacy')                               AS b_paid_legacy,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid_unproven')                             AS b_paid_unproven,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'courier')                                   AS b_courier,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'courier_problem')                           AS b_courier_problem,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'label')                                     AS b_label,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'to_pack')                                   AS b_to_pack,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'returned')                                  AS b_returned,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'cancelled_after_sale')                      AS o_cancelled,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'trashed_after_sale')                        AS o_trashed,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'replacement')                               AS o_replacement,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'altercpa')                   AS src_altercpa,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'elyon_crm')                  AS src_elyon_crm,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'teleshop_out')               AS src_teleshop_out,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'teleshop_other')             AS src_teleshop_other,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'social')                     AS src_social,
         count(*) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total AND e.source = 'web')                        AS src_web,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS value_mkd,
         coalesce(sum(e.cod_mkd)   FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS cod_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'paid'), 0)                 AS paid_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'returned'), 0)             AS returned_mkd,
         coalesce(sum(e.value_mkd) FILTER (WHERE e.k = 's' AND e.cur AND e.bucket = 'cancelled_after_sale'), 0) AS cancelled_mkd,
         coalesce(sum(e.units)     FILTER (WHERE e.k = 's' AND e.cur AND e.in_total), 0)                        AS packages,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur)                                                            AS worked,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'sale')                                     AS sale_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'cancel')                                   AS cancel_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'trash')                                    AS trash_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'callback')                                 AS callback_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.via = 'crm')                                          AS via_crm,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.via = 'altercpa')                                     AS via_altercpa,
         count(*) FILTER (WHERE e.k = 'w' AND e.prev)                                                           AS prev_worked,
         count(*) FILTER (WHERE e.k = 'w' AND e.prev AND e.outcome = 'sale')                                    AS prev_sale_d,
         count(*) FILTER (WHERE e.k = 'w' AND e.cur AND e.outcome = 'sale' AND e.pday)                          AS sale_d_tracked,
         min(e.first_at) FILTER (WHERE e.k = 'w' AND e.cur)                                                     AS first_decision_at,
         max(e.last_at)  FILTER (WHERE e.k = 'w' AND e.cur)                                                     AS last_decision_at,
         sum(e.online)   FILTER (WHERE e.k = 'p')                                                               AS online_min,
         sum(e.active)   FILTER (WHERE e.k = 'p')                                                               AS active_min,
         sum(e.idle)     FILTER (WHERE e.k = 'p')                                                               AS idle_min,
         sum(e.brk)      FILTER (WHERE e.k = 'p')                                                               AS break_min,
         sum(e.alerts)   FILTER (WHERE e.k = 'p')                                                               AS idle_alerts,
         count(*)        FILTER (WHERE e.k = 'p')                                                               AS presence_days,
         min(e.first_at) FILTER (WHERE e.k = 'p')                                                               AS first_active_at,
         max(e.last_at)  FILTER (WHERE e.k = 'p')                                                               AS last_active_at
  FROM ev e
  GROUP BY e.grp, e.person_id
),
ag AS MATERIALIZED (
  SELECT 0 AS g_grp, 0 AS g_person, a.grp, a.person_id,
         a.sales, a.sale_rows, a.booked, a.prev_sales, a.b_paid, a.b_paid_legacy, a.b_paid_unproven,
        a.b_courier, a.b_courier_problem, a.b_label, a.b_to_pack, a.b_returned, a.o_cancelled,
        a.o_trashed, a.o_replacement, a.src_altercpa, a.src_elyon_crm, a.src_teleshop_out, a.src_teleshop_other,
        a.src_social, a.src_web, a.value_mkd, a.cod_mkd, a.paid_mkd, a.returned_mkd, a.cancelled_mkd, a.packages,
        a.worked, a.sale_d, a.cancel_d, a.trash_d, a.callback_d, a.via_crm, a.via_altercpa,
        a.prev_worked, a.prev_sale_d, a.sale_d_tracked, a.first_decision_at, a.last_decision_at,
        a.online_min, a.active_min, a.idle_min, a.break_min, a.idle_alerts, a.presence_days,
        a.first_active_at, a.last_active_at
  FROM ag0 a
  UNION ALL
  SELECT 1 AS g_grp, 0 AS g_person, NULL::text AS grp, a.person_id AS person_id,
         sum(a.sales)::bigint AS sales,
         sum(a.sale_rows)::bigint AS sale_rows,
         sum(a.booked)::bigint AS booked,
         sum(a.prev_sales)::bigint AS prev_sales,
         sum(a.b_paid)::bigint AS b_paid,
         sum(a.b_paid_legacy)::bigint AS b_paid_legacy,
         sum(a.b_paid_unproven)::bigint AS b_paid_unproven,
         sum(a.b_courier)::bigint AS b_courier,
         sum(a.b_courier_problem)::bigint AS b_courier_problem,
         sum(a.b_label)::bigint AS b_label,
         sum(a.b_to_pack)::bigint AS b_to_pack,
         sum(a.b_returned)::bigint AS b_returned,
         sum(a.o_cancelled)::bigint AS o_cancelled,
         sum(a.o_trashed)::bigint AS o_trashed,
         sum(a.o_replacement)::bigint AS o_replacement,
         sum(a.src_altercpa)::bigint AS src_altercpa,
         sum(a.src_elyon_crm)::bigint AS src_elyon_crm,
         sum(a.src_teleshop_out)::bigint AS src_teleshop_out,
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
         sum(a.src_social)::bigint AS src_social,
         sum(a.src_web)::bigint AS src_web,
         sum(a.value_mkd) AS value_mkd,
         sum(a.cod_mkd) AS cod_mkd,
         sum(a.paid_mkd) AS paid_mkd,
         sum(a.returned_mkd) AS returned_mkd,
         sum(a.cancelled_mkd) AS cancelled_mkd,
         sum(a.packages) AS packages,
         sum(a.worked)::bigint AS worked,
         sum(a.sale_d)::bigint AS sale_d,
         sum(a.cancel_d)::bigint AS cancel_d,
         sum(a.trash_d)::bigint AS trash_d,
         sum(a.callback_d)::bigint AS callback_d,
         sum(a.via_crm)::bigint AS via_crm,
         sum(a.via_altercpa)::bigint AS via_altercpa,
         sum(a.prev_worked)::bigint AS prev_worked,
         sum(a.prev_sale_d)::bigint AS prev_sale_d,
         sum(a.sale_d_tracked)::bigint AS sale_d_tracked,
         min(a.first_decision_at) AS first_decision_at,
         max(a.last_decision_at) AS last_decision_at,
         sum(a.online_min)::bigint AS online_min,
         sum(a.active_min)::bigint AS active_min,
         sum(a.idle_min)::bigint AS idle_min,
         sum(a.break_min)::bigint AS break_min,
         sum(a.idle_alerts)::bigint AS idle_alerts,
         sum(a.presence_days)::bigint AS presence_days,
         min(a.first_active_at) AS first_active_at,
         max(a.last_active_at) AS last_active_at
  FROM ag0 a
  GROUP BY a.person_id
  UNION ALL
  SELECT 0 AS g_grp, 1 AS g_person, a.grp AS grp, NULL::uuid AS person_id,
         sum(a.sales)::bigint AS sales,
         sum(a.sale_rows)::bigint AS sale_rows,
         sum(a.booked)::bigint AS booked,
         sum(a.prev_sales)::bigint AS prev_sales,
         sum(a.b_paid)::bigint AS b_paid,
         sum(a.b_paid_legacy)::bigint AS b_paid_legacy,
         sum(a.b_paid_unproven)::bigint AS b_paid_unproven,
         sum(a.b_courier)::bigint AS b_courier,
         sum(a.b_courier_problem)::bigint AS b_courier_problem,
         sum(a.b_label)::bigint AS b_label,
         sum(a.b_to_pack)::bigint AS b_to_pack,
         sum(a.b_returned)::bigint AS b_returned,
         sum(a.o_cancelled)::bigint AS o_cancelled,
         sum(a.o_trashed)::bigint AS o_trashed,
         sum(a.o_replacement)::bigint AS o_replacement,
         sum(a.src_altercpa)::bigint AS src_altercpa,
         sum(a.src_elyon_crm)::bigint AS src_elyon_crm,
         sum(a.src_teleshop_out)::bigint AS src_teleshop_out,
         sum(a.src_teleshop_other)::bigint AS src_teleshop_other,
         sum(a.src_social)::bigint AS src_social,
         sum(a.src_web)::bigint AS src_web,
         sum(a.value_mkd) AS value_mkd,
         sum(a.cod_mkd) AS cod_mkd,
         sum(a.paid_mkd) AS paid_mkd,
         sum(a.returned_mkd) AS returned_mkd,
         sum(a.cancelled_mkd) AS cancelled_mkd,
         sum(a.packages) AS packages,
         sum(a.worked)::bigint AS worked,
         sum(a.sale_d)::bigint AS sale_d,
         sum(a.cancel_d)::bigint AS cancel_d,
         sum(a.trash_d)::bigint AS trash_d,
         sum(a.callback_d)::bigint AS callback_d,
         sum(a.via_crm)::bigint AS via_crm,
         sum(a.via_altercpa)::bigint AS via_altercpa,
         sum(a.prev_worked)::bigint AS prev_worked,
         sum(a.prev_sale_d)::bigint AS prev_sale_d,
         sum(a.sale_d_tracked)::bigint AS sale_d_tracked,
         min(a.first_decision_at) AS first_decision_at,
         max(a.last_decision_at) AS last_decision_at,
         sum(a.online_min)::bigint AS online_min,
         sum(a.active_min)::bigint AS active_min,
         sum(a.idle_min)::bigint AS idle_min,
         sum(a.break_min)::bigint AS break_min,
         sum(a.idle_alerts)::bigint AS idle_alerts,
         sum(a.presence_days)::bigint AS presence_days,
         min(a.first_active_at) AS first_active_at,
         max(a.last_active_at) AS last_active_at
  FROM ag0 a
  GROUP BY a.grp
),
-- the same measures as one jsonb (people, team members and teams share it)
agj AS MATERIALIZED (
  SELECT a.g_grp, a.g_person, a.grp, a.person_id, a.sales, a.sale_rows, a.worked,
         jsonb_build_object(
           'sales',           a.sales,
           'booked',          a.booked,
           'value_mkd',       round(a.value_mkd),
           'cod_mkd',         round(a.cod_mkd),
           'paid_mkd',        round(a.paid_mkd),
           'returned_mkd',    round(a.returned_mkd),
           'cancelled_mkd',   round(a.cancelled_mkd),
           'packages',        a.packages,
           'buckets', jsonb_build_object(
              'paid', a.b_paid, 'paid_legacy', a.b_paid_legacy, 'paid_unproven', a.b_paid_unproven,
              'courier', a.b_courier, 'courier_problem', a.b_courier_problem, 'label', a.b_label,
              'to_pack', a.b_to_pack, 'returned', a.b_returned),
           'outside', jsonb_build_object(
              'cancelled_after_sale', a.o_cancelled, 'trashed_after_sale', a.o_trashed,
              'replacement', a.o_replacement),
           'by_source', jsonb_build_object(
              'altercpa', a.src_altercpa, 'elyon_crm', a.src_elyon_crm, 'teleshop_out', a.src_teleshop_out,
              'teleshop_other', a.src_teleshop_other, 'social', a.src_social, 'web', a.src_web),
           'worked',           a.worked,
           'sale_decisions',   a.sale_d,
           'cancel_decisions', a.cancel_d,
           'trash_decisions',  a.trash_d,
           'callback_decisions', a.callback_d,
           'via_crm',          a.via_crm,
           'via_altercpa',     a.via_altercpa,
           'conversion',       CASE WHEN a.worked > 0 THEN round(a.sale_d::numeric / a.worked, 4) END,
           'first_decision_at', a.first_decision_at,
           'last_decision_at', a.last_decision_at,
           'presence', CASE WHEN a.presence_days > 0 THEN jsonb_build_object(
              'days', a.presence_days, 'online_min', a.online_min, 'active_min', a.active_min,
              'idle_min', a.idle_min, 'break_min', a.break_min, 'idle_alerts', a.idle_alerts,
              'first_active_at', a.first_active_at, 'last_active_at', a.last_active_at,
              'sale_decisions', a.sale_d_tracked) END,
           'prev', CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE jsonb_build_object(
              'sales', a.prev_sales, 'worked', a.prev_worked, 'sale_decisions', a.prev_sale_d) END
         ) AS m
  FROM ag a
),
pid AS (SELECT DISTINCT a.person_id FROM ag a WHERE a.person_id IS NOT NULL),
pinfo AS (
  SELECT sp.id AS person_id, sp.display_name, sp.user_id, sp.is_active,
         (sp.is_manager OR EXISTS (SELECT 1 FROM public.user_roles r
                                    WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         coalesce((SELECT jsonb_agg(DISTINCT i.kind) FROM public.sales_person_identities i WHERE i.person_id = sp.id),
                  '[]'::jsonb) AS kinds
  FROM public.sales_people sp
  WHERE sp.id IN (SELECT pid.person_id FROM pid)
),
-- the team a person's row is shown under: the primary membership on the
-- window's last elapsed day, else any membership in the window, else the
-- group most of their activity fell in
pt AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role, m.lane
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.person_id IN (SELECT pid.person_id FROM pid)
    AND m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
  ORDER BY m.person_id, m.is_primary DESC,
           (least(prm.td, prm.today) BETWEEN m.valid_from AND coalesce(m.valid_to, 'infinity'::date)) DESC,
           m.valid_from DESC
),
pg AS (
  SELECT DISTINCT ON (a.person_id) a.person_id, a.grp
  FROM agj a
  WHERE a.g_grp = 0 AND a.g_person = 0
  ORDER BY a.person_id, (a.sales + a.worked) DESC, a.grp
),
pj AS (
  SELECT coalesce(jsonb_agg(a.m || jsonb_build_object(
           'person_id',      a.person_id,
           'name',           pi.display_name,
           'has_login',      pi.user_id IS NOT NULL,
           'is_manager',     pi.is_manager,
           'is_active',      pi.is_active,
           'identity_kinds', pi.kinds,
           'team_key',       coalesce(pt.team_key, pg.grp, 'none'),
           'team_role',      pt.role,
           'team_lane',      pt.lane,
           'team_kind',      (SELECT st.kind FROM public.sales_teams st WHERE st.key = coalesce(pt.team_key, pg.grp)),
           'online_state',   CASE WHEN pi.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END,
           'groups',         (SELECT jsonb_agg(x.grp ORDER BY x.grp) FROM agj x
                               WHERE x.g_grp = 0 AND x.g_person = 0 AND x.person_id = a.person_id))
         ORDER BY a.sales DESC, a.worked DESC, pi.display_name), '[]'::jsonb) AS j
  FROM agj a
  JOIN pinfo pi ON pi.person_id = a.person_id
  LEFT JOIN pt ON pt.person_id = a.person_id
  LEFT JOIN pg ON pg.person_id = a.person_id
  LEFT JOIN pn ON pn.user_id = pi.user_id
  WHERE a.g_grp = 1 AND a.g_person = 0
    AND ($7::uuid IS NULL OR a.person_id = $7::uuid)
),
-- GET /orders?team_key=T lists the sales of T's PRIMARY members over the
-- window (index.ts): exact only when that is this group's sales, row for row
rost AS (
  SELECT DISTINCT m.team_key, m.person_id
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.is_primary AND m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
),
tdx AS (
  SELECT r.team_key, count(*) AS n_link
  FROM rost r
  JOIN sr s ON s.person_id = r.person_id AND s.cur AND s.kind = 'order'
  GROUP BY r.team_key
),
sk AS (
  SELECT to_char(g, prm.sfmt) AS b
  FROM prm, generate_series(date_trunc(prm.gran, prm.fd::timestamp), date_trunc(prm.gran, prm.td::timestamp),
                            ('1 ' || prm.gran)::interval) g
),
tsp AS MATERIALIZED (
  SELECT e.grp, to_char(date_trunc(prm.gran, e.d::timestamp), prm.sfmt) AS b,
         count(*) FILTER (WHERE e.k = 's' AND e.in_total)          AS sales,
         count(*) FILTER (WHERE e.k = 'w' AND e.outcome = 'sale')  AS sale_d,
         count(*) FILTER (WHERE e.k = 'w')                         AS worked
  FROM ev e CROSS JOIN prm
  WHERE e.cur AND e.k IN ('s', 'w') AND e.d IS NOT NULL
  GROUP BY 1, 2
),
tl AS (
  SELECT DISTINCT ON (m.person_id, m.team_key) m.person_id, m.team_key, m.lane
  FROM public.sales_team_members m
  CROSS JOIN prm
  WHERE m.valid_from <= prm.td AND coalesce(m.valid_to, 'infinity'::date) >= prm.fd
  ORDER BY m.person_id, m.team_key, m.is_primary DESC, m.valid_from DESC
),
tj AS (
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord, x.key), '[]'::jsonb) AS j
  FROM (
    SELECT g.grp AS key,
           -- sales_teams.sort_order (teleshop 10 · affiliate 20 · legacy 40/41 · management 90), then
           -- the groups outside a team
           coalesce(st.sort_order, CASE g.grp WHEN 'teleshop_unassigned' THEN 60 WHEN 'social_unassigned' THEN 61
                                              WHEN 'none' THEN 99 ELSE 70 END) AS ord,
           g.m || jsonb_build_object(
             'key',   g.grp,
             'name',  st.name,
             'mode',  st.leaderboard_mode,
             -- a key in sales_teams is a TEAM (never a pseudo-group, 20260943000950)
             'kind',  CASE WHEN st.key IS NOT NULL THEN 'team' ELSE g.grp END,
             'team_kind', st.kind,
             'sort_order', st.sort_order,
             'lanes', (SELECT jsonb_build_object(
                         'in',     count(*) FILTER (WHERE tl.lane = 'in'),
                         'out',    count(*) FILTER (WHERE tl.lane = 'out'),
                         'social', count(*) FILTER (WHERE tl.lane = 'social'),
                         'none',   count(*) FILTER (WHERE tl.lane IS NULL))
                         FROM agj x
                         LEFT JOIN tl ON tl.person_id = x.person_id AND tl.team_key = x.grp
                        WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp),
             'people', (SELECT count(*) FROM agj x WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp),
             'online_now', (SELECT count(*) FROM agj x
                              JOIN public.sales_people sp ON sp.id = x.person_id
                              JOIN pn ON pn.user_id = sp.user_id
                             WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp AND pn.st IN ('online', 'idle')),
             'break_now', (SELECT count(*) FROM agj x
                             JOIN public.sales_people sp ON sp.id = x.person_id
                             JOIN pn ON pn.user_id = sp.user_id
                            WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp AND pn.st = 'break'),
             'drill_exact', st.key IS NOT NULL AND coalesce(tdx.n_link, 0) = g.sale_rows,
             'members', coalesce((SELECT jsonb_agg(x.m || jsonb_build_object('person_id', x.person_id,
                                                                    'lane', (SELECT tl.lane FROM tl
                                                                              WHERE tl.person_id = x.person_id
                                                                                AND tl.team_key = x.grp))
                                                    ORDER BY x.sales DESC, x.worked DESC, x.person_id)
                                    FROM agj x WHERE x.g_grp = 0 AND x.g_person = 0 AND x.grp = g.grp), '[]'::jsonb),
             'spark', (SELECT jsonb_agg(jsonb_build_object('d', sk.b, 'sales', coalesce(p.sales, 0),
                                                           'sale_decisions', coalesce(p.sale_d, 0),
                                                           'worked', coalesce(p.worked, 0)) ORDER BY sk.b)
                         FROM sk LEFT JOIN tsp p ON p.grp = g.grp AND p.b = sk.b)
           ) AS j
    FROM agj g
    LEFT JOIN public.sales_teams st ON st.key = g.grp
    LEFT JOIN tdx ON tdx.team_key = g.grp
    WHERE g.g_grp = 0 AND g.g_person = 1
  ) x
),
-- sales with no seller: why, per source (Σ people + this = the cohort total)
np AS MATERIALIZED (
  SELECT s.kind, s.source, s.split, s.bucket, s.value_mkd, s.cod_mkd, s.order_id,
         s.sold_at, s.sold_by_ext, s.sold_via, s.display_id
  FROM sr s
  WHERE s.cur AND s.in_total AND s.person_id IS NULL
),
-- the AlterCPA ledger's latest word on each unattributed ORDER (an index
-- probe per order; web / MEX-only rows need none)
nsr AS MATERIALIZED (
  SELECT np.kind, np.source, np.split, np.bucket, np.value_mkd, np.cod_mkd,
         np.sold_by_ext, np.sold_via, ld.decided_by_altercpa_user, ld.account_id,
         CASE WHEN np.sold_via = 'legacy_no_seller' THEN 'legacy_no_seller'   -- accepted, nobody credited (02.10.2026)
              WHEN np.sold_by_ext IS NOT NULL THEN 'unmapped'
              WHEN np.sold_at IS NULL AND ld.decision IN ('approved', 'cancel_other') THEN 'awaiting_stamp'
              WHEN np.sold_at IS NULL AND ld.decision IN ('cancelled', 'trashed') THEN 'altercpa_cancelled'
              ELSE 'no_decider' END AS reason,
         CASE WHEN np.sold_by_ext IS NOT NULL THEN coalesce(np.sold_via, 'other') END AS detail
  FROM np
  LEFT JOIN LATERAL (
    SELECT l.decision, l.decided_by_altercpa_user, l.account_id
    FROM public.altercpa_leads l
    WHERE np.sold_by_ext IS NULL AND l.order_id = np.order_id
    ORDER BY l.decided_at DESC NULLS LAST, l.id
    LIMIT 1) ld ON true
  WHERE np.kind = 'order'
  UNION ALL
  SELECT np.kind, np.source, np.split, np.bucket, np.value_mkd, np.cod_mkd,
         -- a collabBox booking nobody is credited with: its author is a handle
         -- no person holds yet (20260942001900)
         CASE WHEN np.kind = 'booking' THEN
           (SELECT d.author FROM public.collabbox_documents d WHERE d.doc_number = np.display_id) END,
         CASE WHEN np.kind = 'booking' THEN 'collabbox' END,
         NULL, NULL,
         CASE WHEN np.kind = 'web' THEN 'web_shop' WHEN np.kind = 'booking' THEN 'unmapped' ELSE 'mex_only' END,
         CASE WHEN np.kind = 'booking' THEN 'collabbox' ELSE np.split END
  FROM np
  WHERE np.kind <> 'order'
),
nsj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'reason', x.reason, 'source', x.source, 'detail', x.detail,
           'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
           'buckets', jsonb_build_object(
              'paid', x.paid, 'paid_legacy', x.paid_legacy, 'paid_unproven', x.paid_unproven,
              'courier', x.courier, 'courier_problem', x.courier_problem, 'label', x.label,
              'to_pack', x.to_pack, 'returned', x.returned))
         ORDER BY CASE x.source WHEN 'altercpa' THEN 1 WHEN 'elyon_crm' THEN 2 WHEN 'teleshop_out' THEN 3
                           WHEN 'teleshop_other' THEN 4 WHEN 'social' THEN 5 WHEN 'web' THEN 6 ELSE 7 END,
                  x.n DESC, x.reason, x.detail), '[]'::jsonb) AS j
  FROM (
    SELECT n.reason, n.source, n.detail, count(*) AS n,
           coalesce(sum(n.value_mkd), 0) AS v, coalesce(sum(n.cod_mkd), 0) AS c,
           count(*) FILTER (WHERE n.bucket = 'paid')            AS paid,
           count(*) FILTER (WHERE n.bucket = 'paid_legacy')     AS paid_legacy,
           count(*) FILTER (WHERE n.bucket = 'paid_unproven')   AS paid_unproven,
           count(*) FILTER (WHERE n.bucket = 'courier')         AS courier,
           count(*) FILTER (WHERE n.bucket = 'courier_problem') AS courier_problem,
           count(*) FILTER (WHERE n.bucket = 'label')           AS label,
           count(*) FILTER (WHERE n.bucket = 'to_pack')         AS to_pack,
           count(*) FILTER (WHERE n.bucket = 'returned')        AS returned
    FROM nsr n
    GROUP BY 1, 2, 3
  ) x
),
-- the handles nobody has named yet (Settings → Teams → unmapped)
hnd AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('via', x.via, 'handle', x.handle, 'count', x.n,
                                               'value_mkd', round(x.v)) ORDER BY x.n DESC, x.handle), '[]'::jsonb) AS j
  FROM (SELECT n.sold_via AS via, n.sold_by_ext AS handle, count(*) AS n, coalesce(sum(n.value_mkd), 0) AS v
          FROM nsr n WHERE n.reason = 'unmapped'
         GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 25) x
),
-- whose AlterCPA decision (cancel / trash) MEX overruled by delivering anyway
cby AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('person_id', x.person_id, 'name', sp.display_name,
                                               'altercpa_user', x.ext, 'count', x.n, 'value_mkd', round(x.v))
                            ORDER BY x.n DESC, x.ext), '[]'::jsonb) AS j
  FROM (SELECT i.person_id, n.decided_by_altercpa_user AS ext, count(*) AS n, coalesce(sum(n.value_mkd), 0) AS v
          FROM nsr n
          LEFT JOIN public.sales_person_identities i
                 ON i.kind = 'altercpa_user' AND i.account_id = n.account_id
                AND i.value = n.decided_by_altercpa_user::text
         WHERE n.reason = 'altercpa_cancelled'
         GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 12) x
  LEFT JOIN public.sales_people sp ON sp.id = x.person_id
),
-- decisions the ledger could not put on a person
uwj AS (
  SELECT (SELECT count(*) FROM vw WHERE vw.cur AND vw.person_id IS NULL) AS n,
         coalesce(jsonb_agg(jsonb_build_object('via', x.via, 'actor', coalesce(pf.full_name, x.actor_ext), 'count', x.n)
                            ORDER BY x.n DESC, x.actor_ext), '[]'::jsonb) AS j
  FROM (SELECT v.via, v.actor_ext, count(*) AS n FROM vw v
         WHERE v.cur AND v.person_id IS NULL GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 20) x
  LEFT JOIN public.profiles pf ON pf.user_id::text = x.actor_ext
),
tot AS (
  SELECT count(*) FILTER (WHERE s.cur AND s.in_total)                                   AS sales,
         count(*) FILTER (WHERE s.cur AND s.in_total AND s.person_id IS NOT NULL)       AS with_person,
         count(*) FILTER (WHERE s.cur AND s.in_total AND s.kind = 'booking')            AS booked,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.in_total), 0)              AS value_mkd,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.in_total AND s.person_id IS NOT NULL), 0) AS with_person_mkd,
         coalesce(sum(s.cod_mkd)   FILTER (WHERE s.cur AND s.in_total), 0)              AS cod_mkd,
         coalesce(sum(s.value_mkd) FILTER (WHERE s.cur AND s.bucket = 'paid'), 0)       AS paid_mkd,
         count(*) FILTER (WHERE s.prev AND s.in_total)                                  AS prev_sales,
         count(*) FILTER (WHERE s.prev AND s.in_total AND s.person_id IS NOT NULL)      AS prev_with_person
  FROM sr s
),
tsrc AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', x.source, 'sales', x.n, 'with_person', x.wp,
           'value_mkd', round(x.v), 'with_person_mkd', round(x.wv)) ORDER BY x.ord), '[]'::jsonb) AS j
  FROM (SELECT s0.key AS source, s0.ord,
               count(s.source) AS n, count(s.person_id) AS wp,
               coalesce(sum(s.value_mkd), 0) AS v,
               coalesce(sum(s.value_mkd) FILTER (WHERE s.person_id IS NOT NULL), 0) AS wv
          FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                       ('social', 5), ('web', 6)) s0(key, ord)
          LEFT JOIN sr s ON s.source = s0.key AND s.cur AND s.in_total
         GROUP BY 1, 2) x
),
twk AS (
  SELECT count(*) FILTER (WHERE v.cur)                               AS worked,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'sale')        AS sale_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'cancel')      AS cancel_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'trash')       AS trash_d,
         count(*) FILTER (WHERE v.cur AND v.outcome = 'callback')    AS callback_d,
         count(*) FILTER (WHERE v.cur AND v.person_id IS NULL)       AS unmapped,
         count(*) FILTER (WHERE v.prev)                              AS prev_worked,
         count(*) FILTER (WHERE v.prev AND v.outcome = 'sale')       AS prev_sale_d
  FROM vw v
),
bsp AS (
  SELECT to_char(date_trunc(prm.gran, s.sale_day::timestamp), prm.sfmt) AS b,
         count(*) AS sales, count(s.person_id) AS with_person, coalesce(sum(s.value_mkd), 0) AS v
  FROM sr s CROSS JOIN prm
  WHERE s.cur AND s.in_total
  GROUP BY 1
),
wsp AS (
  SELECT to_char(date_trunc(prm.gran, v.d::timestamp), prm.sfmt) AS b,
         count(*) AS worked, count(*) FILTER (WHERE v.outcome = 'sale') AS sale_d
  FROM vw v CROSS JOIN prm
  WHERE v.cur
  GROUP BY 1
),
spj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', sk.b, 'sales', coalesce(b.sales, 0), 'with_person', coalesce(b.with_person, 0),
           'value_mkd', round(coalesce(b.v, 0)), 'worked', coalesce(w.worked, 0),
           'sale_decisions', coalesce(w.sale_d, 0)) ORDER BY sk.b), '[]'::jsonb) AS j
  FROM sk
  LEFT JOIN bsp b ON b.b = sk.b
  LEFT JOIN wsp w ON w.b = sk.b
),
-- ── one person, in depth (only when p_person is given) ─────────────────────
dday AS (
  SELECT sk.b,
         count(*) FILTER (WHERE x.k = 's' AND x.in_total)            AS sales,
         coalesce(sum(x.value_mkd) FILTER (WHERE x.k = 's' AND x.in_total), 0) AS v,
         count(*) FILTER (WHERE x.k = 's' AND x.bucket = 'paid')     AS paid,
         count(*) FILTER (WHERE x.k = 's' AND x.bucket = 'returned') AS returned,
         count(*) FILTER (WHERE x.k = 'w')                           AS worked,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'sale')    AS sale_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'cancel')  AS cancel_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'trash')   AS trash_d,
         count(*) FILTER (WHERE x.k = 'w' AND x.outcome = 'callback') AS callback_d,
         sum(x.online) FILTER (WHERE x.k = 'p')                      AS online_min,
         sum(x.active) FILTER (WHERE x.k = 'p')                      AS active_min
  FROM sk
  LEFT JOIN (SELECT to_char(date_trunc(prm.gran, e.d::timestamp), prm.sfmt) AS b, e.*
               FROM ev e CROSS JOIN prm
              WHERE $7::uuid IS NOT NULL AND e.person_id = $7::uuid AND e.cur AND e.k <> 'r') x ON x.b = sk.b
  WHERE $7::uuid IS NOT NULL
  GROUP BY sk.b
),
dj AS (
  SELECT CASE WHEN $7::uuid IS NULL THEN NULL ELSE jsonb_build_object(
    'person_id', $7::uuid,
    'days', (SELECT coalesce(jsonb_agg(jsonb_build_object(
               'd', d.b, 'sales', d.sales, 'value_mkd', round(d.v), 'paid', d.paid, 'returned', d.returned,
               'worked', d.worked, 'sale_decisions', d.sale_d, 'cancel_decisions', d.cancel_d,
               'trash_decisions', d.trash_d, 'callback_decisions', d.callback_d,
               'online_min', d.online_min, 'active_min', d.active_min) ORDER BY d.b), '[]'::jsonb) FROM dday d),
    'products', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', p.name, 'count', p.n, 'value_mkd', round(p.v))
                                           ORDER BY p.n DESC, p.name), '[]'::jsonb)
                   FROM (SELECT coalesce(nullif(btrim(x.product_name), ''), '__unknown__') AS name,
                                count(*) AS n, coalesce(sum(s.value_mkd), 0) AS v
                           FROM sr s JOIN public.orders x ON x.id = s.order_id
                          WHERE s.cur AND s.in_total AND s.person_id = $7::uuid
                          GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 10) p),
    'identities', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', i.kind, 'value', i.value)
                                             ORDER BY i.kind, i.value), '[]'::jsonb)
                     FROM public.sales_person_identities i WHERE i.person_id = $7::uuid),
    'memberships', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                       'team_key', m.team_key, 'name', st.name, 'from', m.valid_from, 'to', m.valid_to,
                       'role', m.role, 'primary', m.is_primary, 'lane', m.lane, 'kind', st.kind)
                       ORDER BY m.valid_from DESC), '[]'::jsonb)
                      FROM public.sales_team_members m
                      LEFT JOIN public.sales_teams st ON st.key = m.team_key
                     WHERE m.person_id = $7::uuid)) END AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from',           to_char(prm.fd, 'YYYY-MM-DD'),
    'to',             to_char(prm.td, 'YYYY-MM-DD'),
    'granularity',    prm.gran,
    'clock',          'sale',
    'presence_since', $12::text,
    'stamped_at',     $13::timestamptz,
    'person',         $7::uuid),
  'totals', (SELECT jsonb_build_object(
    'sales',           t.sales,
    'value_mkd',       round(t.value_mkd),
    'cod_mkd',         round(t.cod_mkd),
    'paid_mkd',        round(t.paid_mkd),
    'with_person',     t.with_person,
    'booked',          t.booked,
    'with_person_mkd', round(t.with_person_mkd),
    'without_person',  t.sales - t.with_person,
    'without_person_mkd', round(t.value_mkd - t.with_person_mkd),
    'by_source',       (SELECT j FROM tsrc),
    'worked',          w.worked,
    'sale_decisions',  w.sale_d,
    'cancel_decisions', w.cancel_d,
    'trash_decisions', w.trash_d,
    'callback_decisions', w.callback_d,
    'unmapped_decisions', w.unmapped,
    'conversion',      CASE WHEN w.worked > 0 THEN round(w.sale_d::numeric / w.worked, 4) END,
    'prev', CASE WHEN $3::timestamptz IS NULL THEN NULL ELSE jsonb_build_object(
       'sales', t.prev_sales, 'with_person', t.prev_with_person,
       'worked', w.prev_worked, 'sale_decisions', w.prev_sale_d) END)
    FROM tot t CROSS JOIN twk w),
  'teams',        (SELECT j FROM tj),
  'people',       (SELECT j FROM pj),
  'no_seller', (SELECT jsonb_build_object(
    'count',     (SELECT count(*) FROM nsr),
    'value_mkd', (SELECT round(coalesce(sum(nsr.value_mkd), 0)) FROM nsr),
    'reasons',   (SELECT j FROM nsj),
    'handles',   (SELECT j FROM hnd),
    'cancelled_by', (SELECT j FROM cby))),
  'unmapped_work', (SELECT jsonb_build_object('count', u.n, 'actors', u.j) FROM uwj u),
  'spark',        (SELECT j FROM spj),
  'detail',       (SELECT j FROM dj))
FROM prm

$pp$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_fd, v_td, p_person, v_lo,
        (now() AT TIME ZONE 'Europe/Skopje')::date, v_gran, public.report_excluded_phone8s(),
        v_presence, v_stamped;

  RETURN v_out;
END;
$function$;

-- ── 4b. leaderboard_day_v2 (TV board): the same reason, same place ──
CREATE OR REPLACE FUNCTION public.leaderboard_day_v2(p_day date, p_department text DEFAULT NULL::text, p_team text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET jit TO 'off'
AS $function$
DECLARE
  v_day   date := coalesce(p_day, (now() AT TIME ZONE 'Europe/Skopje')::date);
  v_today date := (now() AT TIME ZONE 'Europe/Skopje')::date;
  v_dept  text := nullif(btrim(coalesce(p_department, '')), '');
  v_team  text := nullif(btrim(coalesce(p_team, '')), '');
  v_tkey  text;
  v_tlane text;
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF v_dept IS NOT NULL
     AND v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web') THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown department %', v_dept USING ERRCODE = '22023';
  END IF;
  -- p_team: a team key · 'team:lane' (a line's lane: in | out | social) · 'none' · the legacy
  -- aliases altercpa_leads / crm_prediction (sales_team_filter_matches, 20260943000950 — old TV
  -- links keep working after the teams became business lines)
  IF v_team IS NOT NULL AND v_team <> 'none' THEN
    v_tkey  := split_part(v_team, ':', 1);
    v_tlane := nullif(split_part(v_team, ':', 2), '');
    IF v_team LIKE '%:%:%' OR (v_team LIKE '%:%' AND v_tlane IS NULL)
       OR (v_tlane IS NOT NULL AND v_tlane NOT IN ('in', 'out', 'social'))
       OR NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = v_tkey)
       OR (v_tlane IS NOT NULL AND EXISTS (SELECT 1 FROM public.sales_teams t
                                            WHERE t.key = v_tkey AND t.kind <> 'line')) THEN
      RAISE EXCEPTION 'leaderboard_day_v2: unknown team %', v_team USING ERRCODE = '22023';
    END IF;
  END IF;
  -- Skopje 00:00 of the day and the last microsecond before the next one
  -- (DST-exact: the timestamp is read as Europe/Skopje wall-clock time).
  v_from := v_day::timestamp AT TIME ZONE 'Europe/Skopje';
  v_to   := ((v_day + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond';

  -- $1 from · $2 to_end · $3 day · $4 department · $5 team · $6 is today ·
  -- $7 the test phones' last-8 digits. Every use carries its cast, so
  -- scripts/verify-leaderboard-v2.mjs can run this body inline, read-only.
  EXECUTE $lb2$
WITH
-- ── the owner's test phones: in no report (orders holding one, or its parcel) ─
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($7::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($7::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),

-- ── 1. the work ledger of the day: every human decision, CRM + AlterCPA ────
-- dept = the decided order's department (THE mapping); an AlterCPA decision on
-- a lead with no order is Affiliate – Lead in.
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.order_id, v.outcome,
         CASE WHEN o.id IS NOT NULL
              THEN public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
              WHEN v.via = 'altercpa' THEN 'altercpa' END AS dept,
         (o.id IS NOT NULL AND o.sale_source IS NULL) AS unclassified
  FROM public.v_sales_work v
  LEFT JOIN public.orders o ON o.id = v.order_id
  WHERE v.at BETWEEN $1::timestamptz AND $2::timestamptz
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
),
wk AS (
  SELECT vw.person_id,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.outcome = 'cancel')    AS cancel_d,
         count(*) FILTER (WHERE vw.outcome = 'trash')     AS trash_d,
         count(*) FILTER (WHERE vw.outcome = 'callback')  AS callback_d,
         max(vw.at)                                       AS last_at
  FROM vw WHERE vw.person_id IS NOT NULL GROUP BY 1
),

-- ── 2. THE sale cohort of the day (insights_sale_rows — read, never copied) ─
sr AS MATERIALIZED (
  SELECT r.kind, r.source AS dept, r.sale_source, r.bucket, r.in_total, r.value_mkd, r.order_id,
         r.person_id, r.display_id
  FROM public.insights_sale_rows($1::timestamptz, $2::timestamptz, false) r
),
-- the ORDER sales of the day (+ the ones cancelled / trashed since) and who is
-- credited: the stamp; unstamped → the order's first 'sale' decision of the day
-- that names a person (leaderboard_day's live rule). Stamp or ledger, never both.
so AS MATERIALIZED (
  SELECT s.dept, s.sale_source, s.bucket, s.in_total, s.value_mkd, s.order_id,
         o.sold_at, o.sold_by_ext, o.sold_via,
         CASE WHEN o.sold_at IS NOT NULL THEN o.sold_by_person_id
              ELSE (SELECT w.person_id FROM vw w
                     WHERE w.order_id = s.order_id AND w.outcome = 'sale' AND w.person_id IS NOT NULL
                     ORDER BY w.at LIMIT 1) END AS pid,
         (o.sold_at IS NULL) AS unstamped
  FROM sr s
  JOIN public.orders o ON o.id = s.order_id
  WHERE s.kind = 'order'
    AND (s.in_total OR s.bucket IN ('cancelled_after_sale', 'trashed_after_sale'))
),
-- why a sale has no seller (insights_people's reasons, 20260941000200)
nsr AS (
  SELECT so.dept, so.value_mkd,
         CASE WHEN so.sold_via = 'legacy_no_seller' THEN 'legacy_no_seller'   -- accepted, nobody credited (02.10.2026)
              WHEN so.sold_by_ext IS NOT NULL THEN 'unmapped'
              WHEN so.sold_at IS NULL AND ld.decision IN ('approved', 'cancel_other') THEN 'awaiting_stamp'
              WHEN so.sold_at IS NULL AND ld.decision IN ('cancelled', 'trashed') THEN 'altercpa_cancelled'
              ELSE 'no_decider' END AS reason
  FROM so
  LEFT JOIN LATERAL (
    SELECT l.decision FROM public.altercpa_leads l
     WHERE so.sold_by_ext IS NULL AND l.order_id = so.order_id
     ORDER BY l.decided_at DESC NULLS LAST, l.id
     LIMIT 1) ld ON true
  WHERE so.in_total AND so.pid IS NULL
),

-- ── 3. collabBox bookings (20260942001900): THE cohort's booking rows ──────
-- A document booked in collabBox whose parcel does not exist yet is a sale of
-- the day in the cohort (insights_sale_rows kind 'booking': its folder's
-- department, its author, "to pack") — counted ONCE, from those rows. The
-- day's other collabBox documents no order holds yet (collabbox_booked_today's
-- filter, one document at a time) are shown apart, never counted: the copy of
-- a CRM / AlterCPA sale, a 10111 LEADS document (the shipping document of an
-- AlterCPA sale), a document whose parcel already exists (the parcel counts),
-- … day_totals.checks.bookings_filter_drift = 0 proves the two copies of
-- collabbox_booked_today's filter agree.
bka AS (
  SELECT b.person_id, b.doc_type, sum(b.docs)::bigint AS docs, coalesce(sum(b.value_mkd), 0) AS value_mkd
  FROM public.collabbox_booked_today($3::date) b
  GROUP BY 1, 2
),
bkd AS MATERIALIZED (
  SELECT b.doc_number, b.doc_type_id, b.author_person_id, b.amount_mkd, b.doc_at, b.komitent_id
  FROM public.collabbox_documents b
  -- the day the operator BOOKED it (collabbox_sale_at, 20260944000600); never after doc_at
  WHERE b.doc_at >= $1::timestamptz
    AND public.collabbox_sale_at(b.doc_at, b.booked_at) BETWEEN $1::timestamptz AND $2::timestamptz
    AND b.outcome IN ('booked', 'awaiting_parcel')
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.amount_mkd > 0
    AND b.doc_type_id IN ('10036', '10050', '10111', '10114', '10106')
    AND NOT EXISTS (SELECT 1 FROM public.orders o
                     WHERE o.external_source = 'collabbox' AND o.external_order_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p
                     WHERE p.tracking_id = b.doc_number AND p.order_id IS NOT NULL)
),
-- counted (booked: the cohort's rows) vs not counted (booked_twin: the rest),
-- per person × department
bkc AS (
  SELECT x.person_id, x.dept, bool_or(x.no_dept) AS no_dept,
         sum(x.booked) AS booked, sum(x.booked_mkd) AS booked_mkd,
         sum(x.twin) AS twin, sum(x.twin_mkd) AS twin_mkd, sum(x.twin_by_role) AS twin_by_role
  FROM (
    SELECT s.person_id, s.dept, false AS no_dept,
           1 AS booked, s.value_mkd AS booked_mkd, 0 AS twin, 0::numeric AS twin_mkd, 0 AS twin_by_role
    FROM sr s
    WHERE s.kind = 'booking'
    UNION ALL
    SELECT d.author_person_id, public.cohort_order_source(dp.d[1], dp.d[2], d.doc_number), (dp.d IS NULL),
           0, 0::numeric, 1, d.amount_mkd,
           CASE WHEN public.collabbox_doc_role(d.doc_type_id) = 'credit' THEN 1 ELSE 0 END
    FROM bkd d
    CROSS JOIN LATERAL (SELECT public.collabbox_department(d.doc_type_id, d.doc_number, d.author_person_id, d.doc_at) AS d) dp
    WHERE d.doc_number NOT IN (SELECT s.display_id FROM sr s WHERE s.kind = 'booking')
  ) x
  GROUP BY 1, 2
),

-- ── 4. person × department ─────────────────────────────────────────────────
pd AS MATERIALIZED (
  SELECT x.person_id, x.dept,
         sum(x.sales) AS sales, sum(x.value_mkd) AS value_mkd, sum(x.returned) AS returned,
         sum(x.cas) AS cas, sum(x.cas_mkd) AS cas_mkd, sum(x.live) AS live,
         sum(x.booked) AS booked, sum(x.booked_mkd) AS booked_mkd,
         sum(x.twin) AS twin, sum(x.twin_mkd) AS twin_mkd,
         sum(x.worked) AS worked, sum(x.sale_d) AS sale_d,
         sum(x.cancel_d) AS cancel_d, sum(x.trash_d) AS trash_d, sum(x.callback_d) AS callback_d
  FROM (
    SELECT so.pid AS person_id, so.dept,
           CASE WHEN so.in_total THEN 1 ELSE 0 END AS sales,
           CASE WHEN so.in_total THEN so.value_mkd ELSE 0 END AS value_mkd,
           CASE WHEN so.in_total AND so.bucket = 'returned' THEN 1 ELSE 0 END AS returned,
           CASE WHEN so.in_total THEN 0 ELSE 1 END AS cas,
           CASE WHEN so.in_total THEN 0 ELSE so.value_mkd END AS cas_mkd,
           CASE WHEN so.in_total AND so.unstamped THEN 1 ELSE 0 END AS live,
           0 AS booked, 0 AS booked_mkd, 0 AS twin, 0 AS twin_mkd, 0 AS worked, 0 AS sale_d,
           0 AS cancel_d, 0 AS trash_d, 0 AS callback_d
      FROM so WHERE so.pid IS NOT NULL
    UNION ALL
    SELECT bkc.person_id, bkc.dept, 0, 0, 0, 0, 0, 0,
           bkc.booked, bkc.booked_mkd, bkc.twin, bkc.twin_mkd, 0, 0, 0, 0, 0
      FROM bkc WHERE bkc.person_id IS NOT NULL
    UNION ALL
    SELECT vw.person_id, vw.dept, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
           1, CASE WHEN vw.outcome = 'sale' THEN 1 ELSE 0 END,
           CASE WHEN vw.outcome = 'cancel' THEN 1 ELSE 0 END, CASE WHEN vw.outcome = 'trash' THEN 1 ELSE 0 END,
           CASE WHEN vw.outcome = 'callback' THEN 1 ELSE 0 END
      FROM vw WHERE vw.person_id IS NOT NULL AND vw.dept IS NOT NULL
  ) x
  GROUP BY 1, 2
),
-- a person's numbers: all departments (a) and the filter's department (f)
pa AS (
  SELECT pd.person_id,
         sum(pd.sales) AS sales, sum(pd.value_mkd) AS value_mkd, sum(pd.returned) AS returned,
         sum(pd.cas) AS cas, sum(pd.cas_mkd) AS cas_mkd, sum(pd.live) AS live,
         sum(pd.booked) AS booked, sum(pd.booked_mkd) AS booked_mkd,
         sum(pd.twin) AS twin, sum(pd.twin_mkd) AS twin_mkd,
         sum(pd.worked) AS worked, sum(pd.sale_d) AS sale_d, sum(pd.cancel_d) AS cancel_d,
         sum(pd.trash_d) AS trash_d, sum(pd.callback_d) AS callback_d,
         jsonb_object_agg(pd.dept, jsonb_build_object(
           'sales', pd.sales, 'value_mkd', round(pd.value_mkd),
           'booked', pd.booked, 'booked_value_mkd', round(pd.booked_mkd),
           'booked_twin', pd.twin, 'booked_twin_value_mkd', round(pd.twin_mkd),
           'cancelled_after_sale', pd.cas, 'cancelled_value_mkd', round(pd.cas_mkd),
           'returned', pd.returned, 'live_credited', pd.live,
           'worked', pd.worked, 'sale_decisions', pd.sale_d)) AS depts
  FROM pd
  WHERE pd.dept IS NOT NULL                       -- jsonb_object_agg refuses a NULL key
    AND ($4::text IS NULL OR pd.dept = $4::text)
  GROUP BY 1
),

-- ── 5. who is on the board ─────────────────────────────────────────────────
mem AS (
  SELECT DISTINCT m.person_id
  FROM public.sales_team_members m
  JOIN public.sales_people sp ON sp.id = m.person_id
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
    AND (sp.is_active OR m.valid_to IS NOT NULL)
),
pteam AS (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name,
         m.lane AS team_lane, st.kind AS team_kind, st.sort_order AS team_sort
  FROM public.sales_team_members m
  JOIN public.sales_teams st ON st.key = m.team_key
  WHERE m.valid_from <= $3::date AND coalesce(m.valid_to, 'infinity'::date) >= $3::date
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
pr AS MATERIALIZED (
  SELECT a.user_id, a.online_minutes, a.active_minutes, a.idle_minutes, a.break_minutes,
         a.first_seen_at, a.last_seen_at, a.first_active_at, a.last_active_at, a.idle_alerts,
         a.last_state, a.idle_streak_started_at
  FROM public.agent_presence_days a
  WHERE a.day = $3::date
),
lg AS (
  SELECT u.user_id, min(u.at) AS first_login
  FROM (SELECT s.user_id, s.login_time AS at FROM public.shift_login_logs s WHERE s.shift_date = $3::date
        UNION ALL
        SELECT a.user_id, a.login_time FROM public.admin_login_logs a
         WHERE a.login_time BETWEEN $1::timestamptz AND $2::timestamptz) u
  WHERE u.user_id IS NOT NULL
  GROUP BY 1
),
ppl AS (
  SELECT mem.person_id FROM mem
  UNION SELECT pd.person_id FROM pd
  UNION SELECT sp.id FROM public.sales_people sp JOIN pr ON pr.user_id = sp.user_id
         WHERE coalesce(pr.online_minutes, 0) > 0
  UNION SELECT sp.id FROM public.sales_people sp JOIN lg ON lg.user_id = sp.user_id
),
r0 AS MATERIALIZED (
  SELECT p.person_id, sp.user_id,
         coalesce(sp.display_name, pf.full_name, 'Agent') AS name,
         pt.team_key, pt.team_name, pt.team_lane, pt.team_kind, pt.team_sort,
         EXISTS (SELECT 1 FROM mem WHERE mem.person_id = p.person_id) AS is_member,
         -- management (sales_teams.kind) is shown, never ranked — like is_manager / admin / manager
         (coalesce(sp.is_manager, false)
          OR coalesce(pt.team_kind = 'management', false)
          OR EXISTS (SELECT 1 FROM public.user_roles r
                      WHERE r.user_id = sp.user_id AND r.role::text IN ('admin', 'manager'))) AS is_manager,
         CASE WHEN sp.user_id IS NULL THEN 'n/a'
              WHEN $6::boolean AND pr.last_state IN ('active', 'idle', 'break')
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN CASE pr.last_state WHEN 'active' THEN 'online' ELSE pr.last_state END
              ELSE 'offline' END AS state,
         pr.online_minutes, pr.active_minutes, pr.idle_minutes, pr.break_minutes,
         pr.first_seen_at, pr.last_seen_at, pr.first_active_at, pr.last_active_at, pr.idle_alerts,
         CASE WHEN $6::boolean AND pr.last_state = 'idle' AND pr.idle_streak_started_at IS NOT NULL
                   AND pr.last_seen_at >= now() - interval '3 minutes'
              THEN greatest(0, floor(extract(epoch FROM now() - pr.idle_streak_started_at) / 60))::int END AS idle_streak_min,
         lg.first_login,
         -- the decisions: the whole day, or — with a department chosen — THAT department's
         -- (20260944000600: "Обработени" / conversion ignored the filter). A teleshop department
         -- has no CRM decisions (its calls leave no CRM record): worked 0, conversion NULL → "—".
         CASE WHEN $4::text IS NULL THEN coalesce(wk.worked, 0)     ELSE coalesce(pa.worked, 0)     END AS worked,
         CASE WHEN $4::text IS NULL THEN coalesce(wk.sale_d, 0)     ELSE coalesce(pa.sale_d, 0)     END AS sale_d,
         CASE WHEN $4::text IS NULL THEN coalesce(wk.cancel_d, 0)   ELSE coalesce(pa.cancel_d, 0)   END AS cancel_d,
         CASE WHEN $4::text IS NULL THEN coalesce(wk.trash_d, 0)    ELSE coalesce(pa.trash_d, 0)    END AS trash_d,
         CASE WHEN $4::text IS NULL THEN coalesce(wk.callback_d, 0) ELSE coalesce(pa.callback_d, 0) END AS callback_d,
         wk.last_at,
         coalesce(pa.sales, 0) AS f_sales, coalesce(pa.value_mkd, 0) AS f_value,
         coalesce(pa.returned, 0) AS f_ret, coalesce(pa.cas, 0) AS f_cas, coalesce(pa.cas_mkd, 0) AS f_cas_mkd,
         coalesce(pa.live, 0) AS f_live,
         coalesce(pa.booked, 0) AS f_booked, coalesce(pa.booked_mkd, 0) AS f_booked_mkd,
         coalesce(pa.twin, 0) AS f_twin, coalesce(pa.twin_mkd, 0) AS f_twin_mkd,
         coalesce(pa.sales, 0) + coalesce(pa.booked, 0) AS f_total,
         coalesce(pa.value_mkd, 0) + coalesce(pa.booked_mkd, 0) AS f_total_mkd,
         (coalesce(pa.sales, 0) + coalesce(pa.cas, 0) + coalesce(pa.booked, 0)
          + coalesce(pa.twin, 0) + coalesce(pa.worked, 0)) > 0 AS f_any,
         coalesce(pa.depts, '{}'::jsonb) AS depts
  FROM ppl p
  JOIN public.sales_people sp ON sp.id = p.person_id
  LEFT JOIN public.profiles pf ON pf.user_id = sp.user_id
  LEFT JOIN pteam pt ON pt.person_id = p.person_id
  LEFT JOIN pr ON pr.user_id = sp.user_id
  LEFT JOIN lg ON lg.user_id = sp.user_id
  LEFT JOIN wk ON wk.person_id = p.person_id
  LEFT JOIN pa ON pa.person_id = p.person_id
),
-- the filter: a department keeps the people with anything in it; a team keeps its badge holders
-- ('team:lane' → that lane's; the legacy aliases → sales_team_filter_matches)
rf AS (
  SELECT r0.* FROM r0
  WHERE ($4::text IS NULL OR r0.f_any)
    AND ($5::text IS NULL OR public.sales_team_filter_matches($5::text, r0.team_key, r0.team_lane))
),
rk AS (
  SELECT rf.*,
         CASE WHEN NOT rf.is_manager AND rf.f_total > 0
              THEN rank() OVER (PARTITION BY (NOT rf.is_manager AND rf.f_total > 0)
                                ORDER BY rf.f_total_mkd DESC, rf.f_total DESC) END AS rnk,
         CASE rf.state WHEN 'online' THEN 0 WHEN 'idle' THEN 1 WHEN 'break' THEN 2 WHEN 'offline' THEN 3 ELSE 4 END AS st_ord
  FROM rf
),

-- ── 6. the whole day by department (never filtered) — the tie-out ──────────
dk AS (
  SELECT d.key, d.ord
  FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3),
               ('teleshop_other', 4), ('social', 5), ('web', 6)) d(key, ord)
),
sagg AS (
  SELECT so.dept,
         count(*) FILTER (WHERE so.in_total)                                        AS sales,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total), 0)                  AS value_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NOT NULL)                 AS credited,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NOT NULL), 0) AS credited_mkd,
         count(*) FILTER (WHERE so.in_total AND so.pid IS NULL)                     AS no_seller,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.pid IS NULL), 0) AS no_seller_mkd,
         count(*) FILTER (WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL) AS live,
         count(*) FILTER (WHERE NOT so.in_total)                                    AS cas,
         coalesce(sum(so.value_mkd) FILTER (WHERE NOT so.in_total), 0)              AS cas_mkd,
         count(*) FILTER (WHERE so.in_total AND so.sale_source IS NULL)             AS unclassified,
         coalesce(sum(so.value_mkd) FILTER (WHERE so.in_total AND so.sale_source IS NULL), 0) AS unclassified_mkd
  FROM so GROUP BY 1
),
oagg AS (   -- the cohort's sales no person can hold: the web shop and MEX parcels with no order
  SELECT sr.dept,
         count(*) FILTER (WHERE sr.kind = 'web')                           AS web,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'web'), 0)     AS web_mkd,
         count(*) FILTER (WHERE sr.kind = 'mex')                           AS mex_only,
         coalesce(sum(sr.value_mkd) FILTER (WHERE sr.kind = 'mex'), 0)     AS mex_only_mkd
  FROM sr WHERE sr.in_total AND sr.kind <> 'order' GROUP BY 1
),
bagg AS (
  SELECT bkc.dept,
         sum(bkc.booked)                                                   AS booked,
         sum(bkc.booked_mkd)                                               AS booked_mkd,
         coalesce(sum(bkc.booked) FILTER (WHERE bkc.person_id IS NULL), 0)     AS booked_no_person,
         coalesce(sum(bkc.booked_mkd) FILTER (WHERE bkc.person_id IS NULL), 0) AS booked_no_person_mkd,
         sum(bkc.twin)                                                     AS twin,
         sum(bkc.twin_mkd)                                                 AS twin_mkd,
         sum(bkc.twin_by_role)                                             AS twin_by_role
  FROM bkc GROUP BY 1
),
wagg AS (
  SELECT vw.dept,
         count(*)                                         AS worked,
         count(*) FILTER (WHERE vw.outcome = 'sale')      AS sale_d,
         count(*) FILTER (WHERE vw.person_id IS NULL)     AS unmapped
  FROM vw GROUP BY 1
)
SELECT jsonb_build_object(
  'version', 2,
  'day', $3::date,
  'is_today', $6::boolean,
  'generated_at', now(),
  'window', jsonb_build_object('from', $1::timestamptz, 'to_end', $2::timestamptz),
  'filter', jsonb_build_object('department', $4::text, 'team', $5::text),
  'departments', (SELECT jsonb_agg(dk.key ORDER BY dk.ord) FROM dk),
  -- the teams on the (department-filtered) board, for the filter bar: sales_teams.sort_order,
  -- each line with its lanes ('team:lane' is a filter value)
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                     'key', t.k, 'name', t.nm, 'people', t.n, 'kind', t.kd, 'sort_order', t.ord,
                     'lanes', (SELECT coalesce(jsonb_agg(jsonb_build_object('lane', l.lane, 'key', t.k || ':' || l.lane,
                                                                            'people', l.n)
                                                         ORDER BY CASE l.lane WHEN 'in' THEN 1 WHEN 'out' THEN 2 ELSE 3 END),
                                               '[]'::jsonb)
                                 FROM (SELECT r1.team_lane AS lane, count(*) AS n
                                         FROM r0 r1
                                        WHERE r1.team_key = t.k AND r1.team_lane IS NOT NULL
                                          AND ($4::text IS NULL OR r1.f_any)
                                        GROUP BY 1) l))
                                      ORDER BY t.ord, t.k), '[]'::jsonb)
              FROM (SELECT coalesce(r0.team_key, 'none') AS k, max(r0.team_name) AS nm, count(*) AS n,
                           max(r0.team_kind) AS kd,
                           min(coalesce(r0.team_sort, CASE WHEN r0.team_key IS NULL THEN 99 ELSE 70 END)) AS ord
                      FROM r0 WHERE $4::text IS NULL OR r0.f_any
                     GROUP BY 1) t),
  -- the people shown (after the filters)
  'summary', (SELECT jsonb_build_object(
      'people',           count(*),
      'members',          count(*) FILTER (WHERE rk.is_member),
      'managers',         count(*) FILTER (WHERE rk.is_manager),
      'ranked',           count(*) FILTER (WHERE rk.rnk IS NOT NULL),
      'online_now',       count(*) FILTER (WHERE rk.state IN ('online', 'idle')),
      'idle',             count(*) FILTER (WHERE rk.state = 'idle'),
      'on_break',         count(*) FILTER (WHERE rk.state = 'break'),
      'offline',          count(*) FILTER (WHERE rk.state = 'offline'),
      'no_login',         count(*) FILTER (WHERE rk.state = 'n/a'),
      'was_online',       count(*) FILTER (WHERE coalesce(rk.online_minutes, 0) > 0),
      'zero_sale_people', count(*) FILTER (WHERE NOT rk.is_manager AND rk.f_total = 0),
      'worked',           coalesce(sum(rk.worked), 0),
      'sale_decisions',   coalesce(sum(rk.sale_d), 0),
      'sales',            coalesce(sum(rk.f_sales), 0),
      'value_mkd',        round(coalesce(sum(rk.f_value), 0)),
      'booked',           coalesce(sum(rk.f_booked), 0),
      'booked_value_mkd', round(coalesce(sum(rk.f_booked_mkd), 0)),
      'total_count',      coalesce(sum(rk.f_total), 0),
      'total_value_mkd',  round(coalesce(sum(rk.f_total_mkd), 0)),
      'cancelled_after_sale', coalesce(sum(rk.f_cas), 0),
      'returned',         coalesce(sum(rk.f_ret), 0),
      'live_credited',    coalesce(sum(rk.f_live), 0),
      'booked_twin',      coalesce(sum(rk.f_twin), 0),
      'booked_twin_value_mkd', round(coalesce(sum(rk.f_twin_mkd), 0)),
      -- the department's (or the day's) sales no person is credited with
      'no_seller',        (SELECT coalesce(sum(sagg.no_seller), 0) FROM sagg
                            WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'no_seller_value_mkd', (SELECT round(coalesce(sum(sagg.no_seller_mkd), 0)) FROM sagg
                               WHERE $4::text IS NULL OR sagg.dept = $4::text),
      'booked_no_person', (SELECT coalesce(sum(bagg.booked_no_person), 0) FROM bagg
                            WHERE $4::text IS NULL OR bagg.dept = $4::text))
    FROM rk),
  'day_totals', jsonb_build_object(
    'by_department', (SELECT jsonb_object_agg(dk.key, jsonb_build_object(
        'sales',            coalesce(s.sales, 0),
        'value_mkd',        round(coalesce(s.value_mkd, 0)),
        'credited',         coalesce(s.credited, 0),
        'credited_value_mkd', round(coalesce(s.credited_mkd, 0)),
        'no_seller',        coalesce(s.no_seller, 0),
        'no_seller_value_mkd', round(coalesce(s.no_seller_mkd, 0)),
        'live_credited',    coalesce(s.live, 0),
        'cancelled_after_sale', coalesce(s.cas, 0),
        'cancelled_value_mkd', round(coalesce(s.cas_mkd, 0)),
        'booked',           coalesce(b.booked, 0),
        'booked_value_mkd', round(coalesce(b.booked_mkd, 0)),
        'booked_no_person', coalesce(b.booked_no_person, 0),
        'booked_no_person_value_mkd', round(coalesce(b.booked_no_person_mkd, 0)),
        'booked_twin',      coalesce(b.twin, 0),
        'booked_twin_value_mkd', round(coalesce(b.twin_mkd, 0)),
        'booked_twin_by_role', coalesce(b.twin_by_role, 0),
        'web',              coalesce(o.web, 0),
        'web_value_mkd',    round(coalesce(o.web_mkd, 0)),
        'mex_only',         coalesce(o.mex_only, 0),
        'mex_only_value_mkd', round(coalesce(o.mex_only_mkd, 0)),
        'worked',           coalesce(w.worked, 0),
        'sale_decisions',   coalesce(w.sale_d, 0),
        'unmapped_decisions', coalesce(w.unmapped, 0)))
      FROM dk
      LEFT JOIN sagg s ON s.dept = dk.key
      LEFT JOIN bagg b ON b.dept = dk.key
      LEFT JOIN oagg o ON o.dept = dk.key
      LEFT JOIN wagg w ON w.dept = dk.key),
    'sales',            (SELECT count(*) FROM so WHERE so.in_total),
    'value_mkd',        (SELECT round(coalesce(sum(so.value_mkd), 0)) FROM so WHERE so.in_total),
    'credited',         (SELECT count(*) FROM so WHERE so.in_total AND so.pid IS NOT NULL),
    'live_credited',    (SELECT count(*) FROM so WHERE so.in_total AND so.unstamped AND so.pid IS NOT NULL),
    'worked',           (SELECT count(*) FROM vw),
    'unmapped_decisions', (SELECT count(*) FROM vw WHERE vw.person_id IS NULL),
    'no_seller', jsonb_build_object(
      'sales',     (SELECT count(*) FROM nsr),
      'value_mkd', (SELECT round(coalesce(sum(nsr.value_mkd), 0)) FROM nsr),
      'reasons',   (SELECT coalesce(jsonb_agg(jsonb_build_object('reason', x.reason, 'department', x.dept,
                                                                 'count', x.n, 'value_mkd', round(x.v))
                                              ORDER BY x.n DESC, x.reason, x.dept), '[]'::jsonb)
                      FROM (SELECT nsr.reason, nsr.dept, count(*) AS n, coalesce(sum(nsr.value_mkd), 0) AS v
                              FROM nsr GROUP BY 1, 2) x),
      'booked',    (SELECT coalesce(sum(bkc.booked), 0) FROM bkc WHERE bkc.person_id IS NULL),
      'booked_value_mkd', (SELECT round(coalesce(sum(bkc.booked_mkd), 0)) FROM bkc WHERE bkc.person_id IS NULL)),
    -- safety: 0 everywhere, or a mapping has a gap
    'no_department', jsonb_build_object(
      'orders',           (SELECT coalesce(sum(sagg.unclassified), 0) FROM sagg),
      'orders_value_mkd', (SELECT round(coalesce(sum(sagg.unclassified_mkd), 0)) FROM sagg),
      'bookings',         (SELECT coalesce(sum(bkc.booked + bkc.twin), 0) FROM bkc WHERE bkc.no_dept),
      'work',             (SELECT count(*) FROM vw WHERE vw.dept IS NULL OR vw.unclassified)),
    'checks', jsonb_build_object(
      'bookings_filter_drift', (SELECT coalesce(sum(bka.docs), 0) FROM bka) - (SELECT count(*) FROM bkd))),
  'rows', coalesce((
    SELECT jsonb_agg(jsonb_build_object(
      'person_id',        rk.person_id,
      'user_id',          rk.user_id,
      'name',             rk.name,
      'team_key',         rk.team_key,
      'team_name',        rk.team_name,
      'team_lane',        rk.team_lane,
      'team_kind',        rk.team_kind,
      'is_member',        rk.is_member,
      'is_manager',       rk.is_manager,
      'rank',             rk.rnk,
      'sales',            rk.f_sales,
      'value_mkd',        round(rk.f_value),
      'booked',           rk.f_booked,
      'booked_value_mkd', round(rk.f_booked_mkd),
      'total_count',      rk.f_total,
      'total_value_mkd',  round(rk.f_total_mkd),
      'cancelled_after_sale', rk.f_cas,
      'cancelled_value_mkd', round(rk.f_cas_mkd),
      'returned',         rk.f_ret,
      'live_credited',    rk.f_live,
      'booked_twin',      rk.f_twin,
      'booked_twin_value_mkd', round(rk.f_twin_mkd),
      'worked',           rk.worked,
      'sale_decisions',   rk.sale_d,
      'cancelled',        rk.cancel_d,
      'trashed',          rk.trash_d,
      'callbacks',        rk.callback_d,
      'conversion',       CASE WHEN rk.worked > 0 THEN round(rk.sale_d::numeric / rk.worked, 4) END,
      'last_decision_at', rk.last_at,
      'departments',      rk.depts,
      'presence', jsonb_build_object(
        'state',           rk.state,
        'online_min',      coalesce(rk.online_minutes, 0),
        'active_min',      coalesce(rk.active_minutes, 0),
        'idle_min',        coalesce(rk.idle_minutes, 0),
        'break_min',       coalesce(rk.break_minutes, 0),
        'first_seen',      rk.first_seen_at,
        'last_seen',       rk.last_seen_at,
        'first_active',    rk.first_active_at,
        'last_active',     rk.last_active_at,
        'idle_alerts',     coalesce(rk.idle_alerts, 0),
        'idle_streak_min', rk.idle_streak_min,
        'first_login',     rk.first_login))
      ORDER BY CASE WHEN rk.rnk IS NOT NULL THEN 0 WHEN NOT rk.is_manager THEN 1 ELSE 2 END,
               rk.rnk, rk.f_total_mkd DESC, rk.f_total DESC, rk.worked DESC, rk.st_ord,
               coalesce(rk.active_minutes, 0) DESC, rk.name, rk.person_id)
    FROM rk), '[]'::jsonb)
)
  $lb2$
  INTO v_out
  USING v_from, v_to, v_day, v_dept, v_team, (v_day = v_today), public.report_excluded_phone8s();

  RETURN v_out;
END;
$function$;

-- ── 5. sales_teams_unmapped (Settings → Teams): a marked sale is not a handle to name ──
CREATE OR REPLACE FUNCTION public.sales_teams_unmapped(p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
WITH win AS (
  SELECT greatest(1, least(coalesce(p_days, 90), 400)) AS days,
         now() - make_interval(days => greatest(1, least(coalesce(p_days, 90), 400))) AS since
),
-- AlterCPA operators who decided MK leads in the window but name nobody.
acpa AS (
  SELECT l.account_id, l.decided_by_altercpa_user AS uid,
         count(*)                                                         AS decisions,
         count(*) FILTER (WHERE l.decision IN ('approved', 'cancel_other')) AS sales,
         min(l.decided_at) AS first_at, max(l.decided_at) AS last_at,
         (array_agg(jsonb_build_object('id', o.id, 'display_id', o.display_id)
                    ORDER BY l.decided_at DESC) FILTER (WHERE o.id IS NOT NULL))[1:5] AS sample
    FROM public.altercpa_leads l
    CROSS JOIN win
    LEFT JOIN public.orders o ON o.id = l.order_id
   WHERE upper(coalesce(l.geo, '')) = 'MK'
     AND l.decision IS NOT NULL
     AND l.skip_reason IS DISTINCT FROM 'test_order'
     AND l.decided_by_altercpa_user IS NOT NULL
     AND l.decided_at >= win.since
     AND NOT EXISTS (SELECT 1 FROM public.sales_person_identities i
                      WHERE i.kind = 'altercpa_user' AND i.account_id = l.account_id
                        AND i.value = l.decided_by_altercpa_user::text)
   GROUP BY l.account_id, l.decided_by_altercpa_user
),
-- The seed's placeholders for ids nobody has named ("AlterCPA #4531 (unnamed)",
-- scripts/seed-sales-people.mjs): a person with no login and that name shape.
unnamed AS (
  SELECT sp.id, sp.display_name, sp.notes,
         (SELECT string_agg(i.value, ', ' ORDER BY i.value) FROM public.sales_person_identities i
           WHERE i.person_id = sp.id AND i.kind = 'altercpa_user') AS altercpa_ids,
         (SELECT count(*) FROM public.v_sales_work w, win
           WHERE w.person_id = sp.id AND w.at >= win.since) AS decisions,
         (SELECT max(w.at) FROM public.v_sales_work w WHERE w.person_id = sp.id) AS last_at
    FROM public.sales_people sp
   WHERE sp.user_id IS NULL
     AND sp.display_name ~ '^AlterCPA #[0-9]+'
),
-- CRM logins holding an agent role that are nobody. Test logins (the seed's
-- isTestLogin rule) are flagged, not hidden.
logins AS (
  SELECT p.user_id, p.full_name, p.email, p.is_active, p.last_seen_at,
         array_agg(DISTINCT r.role::text ORDER BY r.role::text) AS roles,
         (SELECT max(h.changed_at) FROM public.order_history h WHERE h.changed_by = p.user_id) AS last_work_at,
         (coalesce(p.full_name, '') ~* '(^|[[:space:]_.-])(test|qa|e2e)([[:space:]_.-]|$)'
          OR coalesce(p.full_name, '') ~* 'тест'
          OR split_part(coalesce(p.email, ''), '@', 1) ~* '^(qa-|test|pregled)') AS is_test
    FROM public.profiles p
    JOIN public.user_roles r ON r.user_id = p.user_id
   WHERE r.role::text IN ('agent', 'pending_agent', 'prediction_agent', 'inbound_agent')
     AND NOT EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.user_id = p.user_id)
   GROUP BY p.user_id, p.full_name, p.email, p.is_active, p.last_seen_at
),
-- Sales in the window that name no person: stamped with a decider key nobody
-- owns, or real sales never stamped at all (the backfill has not reached them).
ord AS (
  SELECT coalesce(o.sold_by_ext, nullif(btrim(o.confirmed_by_name), '')) AS ext,
         o.sold_via,
         (o.sold_at IS NOT NULL) AS stamped,
         o.sale_source,
         count(*) AS n,
         min(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS first_at,
         max(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS last_at,
         (array_agg(jsonb_build_object('id', o.id, 'display_id', o.display_id)
                    ORDER BY coalesce(o.sold_at, o.confirmed_at, o.created_at) DESC))[1:5] AS sample
    FROM public.orders o
    CROSS JOIN win
   WHERE o.sold_by_person_id IS NULL
     AND o.sold_via IS DISTINCT FROM 'legacy_no_seller'   -- accepted with no seller (02.10.2026)
     AND ((o.sold_at IS NOT NULL AND o.sold_at >= win.since)
       OR (o.sold_at IS NULL
           AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
           AND coalesce(o.price, 0) > 0
           AND NOT public.is_synthetic_product_name(o.product_name)
           AND coalesce(o.confirmed_at, o.created_at) >= win.since))
   GROUP BY 1, 2, 3, 4
)
SELECT jsonb_build_object(
  'days', (SELECT days FROM win),
  'altercpa', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'account_id', a.account_id, 'account_name', ac.name, 'altercpa_user', a.uid,
                  'decisions', a.decisions, 'sales', a.sales, 'first_at', a.first_at, 'last_at', a.last_at,
                  'sample', to_jsonb(coalesce(a.sample, ARRAY[]::jsonb[])))
                ORDER BY a.decisions DESC, a.uid), '[]'::jsonb)
                 FROM acpa a LEFT JOIN public.altercpa_accounts ac ON ac.id = a.account_id),
  'unnamed', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                 'person_id', u.id, 'display_name', u.display_name, 'notes', u.notes,
                 'altercpa_ids', u.altercpa_ids, 'decisions', u.decisions, 'last_at', u.last_at)
               ORDER BY u.decisions DESC, u.display_name), '[]'::jsonb)
                FROM unnamed u),
  'logins', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'user_id', g.user_id, 'full_name', g.full_name, 'email', g.email, 'is_active', g.is_active,
                'roles', to_jsonb(g.roles), 'last_seen_at', g.last_seen_at, 'last_work_at', g.last_work_at,
                'is_test', g.is_test)
              ORDER BY g.is_active DESC, g.is_test, lower(coalesce(g.full_name, g.email, ''))), '[]'::jsonb)
               FROM logins g),
  'orders', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                'ext', x.ext, 'sold_via', x.sold_via, 'stamped', x.stamped, 'sale_source', x.sale_source,
                'n', x.n, 'first_at', x.first_at, 'last_at', x.last_at,
                'sample', to_jsonb(coalesce(x.sample, ARRAY[]::jsonb[])))
              ORDER BY x.n DESC, x.ext NULLS LAST), '[]'::jsonb)
               FROM ord x)
);
$function$;

