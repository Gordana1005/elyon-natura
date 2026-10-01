-- ============================================================================
-- The BOOKING day everywhere live, and two leaderboard fixes (owner, 01.10.2026)
--
-- Apply AFTER 20260944000500_collabbox_booked_at.sql (collabbox_documents.booked_at,
-- public.collabbox_sale_at). "One calculation everywhere": the Insights cohort, Операции and the TV
-- board read the same rows, so the change is made once per reader:
--
--   insights_sale_rows   a collabBox booking row's sale day = collabbox_sale_at(doc_at, booked_at) —
--                        the day the operator booked it (from 01.10.2026 on; doc_at is the dispatch
--                        day). FIX B (the morning gap): a booking stays a booking until an ORDER holds
--                        its parcel — MEX registers the night's parcels ~07:34, mex-reconcile reads
--                        them ~07:37, the collabBox pass makes the orders ~07:50; in between the
--                        booking used to drop out (any parcel ended it) and its parcel counted as a
--                        MEX-only sale with no seller on the PARCEL's day (01.10: ~157 sales of 30.09
--                        sat on 01.10 for those 13 minutes). Now neither happens: bk0 ends a booking
--                        only on a parcel an order holds, and mo never counts a parcel whose
--                        document is still counted as a booking (bk — every waiting booking, the
--                        window is applied in bkr).
--   leaderboard_day_v2   its copy of collabbox_booked_today's filter (bkd) reads the booking day too
--                        (checks.bookings_filter_drift stays 0). FIX A: with a department chosen,
--                        "Обработени" / sale decisions / cancelled / trashed / callbacks / conversion
--                        are THAT department's (they were the whole day's, every department — a
--                        teleshop agent showed her affiliate conversion on the teleshop board); a
--                        department with no CRM decisions (teleshop calls leave no CRM record) has
--                        worked 0 and conversion NULL → the TV shows "—".
--   insights_work        the authors of the period's bookings (their rows) by the booking day.
--   order_origin         the collabBox document carries booked_at (+ basis): the order window shows
--                        "booked … · for dispatch dd.mm" (OrderOriginPanel).
-- Signatures, grants and every other number are unchanged. Every body is the LIVE one
-- (pg_get_functiondef, 01.10.2026) with counted, exact edits; the drift guard refuses if any changed.
-- Check: node scripts/verify-booking-day.mjs (B1–B4) · verify-insights-ties · verify-leaderboard-v2 ·
-- verify-attribution. Revert: re-apply the previous bodies (git).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', 'c48795ea0cf5479505b43eaa73416bcb', 'e7406338692acb5caa2e165d404ccc0c'),
    ('public.leaderboard_day_v2(date,text,text)', 'fdf91bb7d74f2914c223721e2d04e5ec', '60e1e9aeef4d34ab2c31e68679828ce6'),
    ('public.insights_work(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)', '24e7a6cf03d4bb09227c9783f992e7bb', '538f9c8a89ef3c50de6188ee1907b0ac'),
    ('public.order_origin(uuid)', '9ca305840237e4f02b51191abb3a7f11', '9fb17c32202466be99f84617f850bca4')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'booking day readers: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  IF to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                      AND table_name = 'collabbox_documents' AND column_name = 'booked_at') THEN
    RAISE EXCEPTION 'booking day readers: apply 20260944000500_collabbox_booked_at.sql first';
  END IF;
END
$drift$;

-- ── 1. THE cohort's rows: bookings on their booking day, the morning gap closed ─
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
         x.sold_by_person_id, x.prediction_list_id, x.prediction_list_name,
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
         (ob.sold_by_person_id IS NULL AND public.cohort_in_total(ob.bucket)) AS q_no_seller,
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
-- own sale within 10 minutes of the document (a LEADS-OUT copied from the CRM
-- sale the same agent just made). Nor a test phone.
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
         AND x.created_at BETWEEN k.doc_at - interval '10 minutes' AND k.doc_at + interval '10 minutes'
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

-- ── 2. the TV board: its bookings filter + the department's decisions ───────
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
         o.sold_at, o.sold_by_ext,
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
         CASE WHEN so.sold_by_ext IS NOT NULL THEN 'unmapped'
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

-- ── 3. call activity: the authors of the period's bookings ─────────────────
CREATE OR REPLACE FUNCTION public.insights_work(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_user_id uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_pf        timestamptz;
  v_pt        timestamptz;
  v_me        uuid;
  v_excluded  text[];
  v_out       jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_work: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_work: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  -- The self view (a login holding call_activity that is not admin/manager/
  -- owner): only that login's person, calls and presence.
  IF p_user_id IS NOT NULL THEN
    SELECT sp.id INTO v_me FROM public.sales_people sp WHERE sp.user_id = p_user_id;
  END IF;

  -- The owner's test phones (public.report_excluded_phones): read once, a
  -- constant for the planner — the foundation's rule.
  v_excluded := public.report_excluded_phone8s();

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 test phones ·
  -- $6 self login (NULL = everyone) · $7 the self login's person
  EXECUTE $core$
WITH
w AS (
  SELECT z.f, z.t, z.pf, z.pt,
         (z.f AT TIME ZONE 'Europe/Skopje')::date  AS fd,
         (z.t AT TIME ZONE 'Europe/Skopje')::date  AS td,
         (z.pf AT TIME ZONE 'Europe/Skopje')::date AS pfd,
         (z.pt AT TIME ZONE 'Europe/Skopje')::date AS ptd,
         CASE WHEN (z.t AT TIME ZONE 'Europe/Skopje')::date - (z.f AT TIME ZONE 'Europe/Skopje')::date + 1 <= 62
              THEN 'day' ELSE 'week' END AS gran
  FROM (SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt) z
),
-- the owner's test phones: their orders are in no number (insights_overview's xto)
xtp AS MATERIALIZED (
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($5::text[])
),
xto AS MATERIALIZED (
  SELECT x.id FROM public.orders x
   WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY ($5::text[])
  UNION
  SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id
),
-- ── the ledgers, both windows at once (cur = this period) ──────────────────
vw AS MATERIALIZED (
  SELECT v.at, v.person_id, v.via, v.outcome, v.actor_ext,
         (v.at AT TIME ZONE 'Europe/Skopje') AS lt,
         (v.at BETWEEN w.f AND w.t)          AS cur
  FROM public.v_sales_work v, w
  WHERE (v.at BETWEEN w.f AND w.t OR v.at BETWEEN w.pf AND w.pt)
    AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT xto.id FROM xto))
    AND ($6::uuid IS NULL OR v.person_id = $7::uuid)
),
cl AS MATERIALIZED (
  SELECT c.agent_id, sp.id AS person_id, c.outcome, c.started_at,
         coalesce(c.total_seconds, 0)                                 AS total_seconds,
         coalesce(c.started_at, c.created_at)                         AS at,
         (coalesce(c.started_at, c.created_at) AT TIME ZONE 'Europe/Skopje') AS lt,
         (coalesce(c.started_at, c.created_at) BETWEEN w.f AND w.t)   AS cur
  FROM public.call_logs c
  CROSS JOIN w
  LEFT JOIN public.sales_people sp ON sp.user_id = c.agent_id
  WHERE (coalesce(c.started_at, c.created_at) BETWEEN w.f AND w.t
         OR coalesce(c.started_at, c.created_at) BETWEEN w.pf AND w.pt)
    AND NOT public.insights_excluded8(public.insights_phone8(c.customer_phone), $5::text[])
    AND ($6::uuid IS NULL OR c.agent_id = $6::uuid)
),
pr AS MATERIALIZED (
  SELECT sp.id AS person_id, a.day, a.online_minutes, a.active_minutes, a.idle_minutes,
         a.break_minutes, a.idle_alerts, a.first_active_at, a.last_active_at,
         (a.day BETWEEN w.fd AND w.td) AS cur
  FROM public.agent_presence_days a
  CROSS JOIN w
  JOIN public.sales_people sp ON sp.user_id = a.user_id
  WHERE (a.day BETWEEN w.fd AND w.td OR a.day BETWEEN w.pfd AND w.ptd)
    AND ($6::uuid IS NULL OR a.user_id = $6::uuid)
),
brk AS MATERIALIZED (
  SELECT sp.id AS person_id,
         greatest(0, extract(epoch FROM (least(coalesce(b.break_end, now()), w.t) - b.break_start)) / 60.0) AS mins
  FROM public.shift_breaks b
  CROSS JOIN w
  JOIN public.sales_people sp ON sp.user_id = b.user_id
  WHERE b.break_start BETWEEN w.f AND w.t
    AND ($6::uuid IS NULL OR b.user_id = $6::uuid)
),
-- ONE team per person for the window (see the header)
mem AS MATERIALIZED (
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role, m.lane
  FROM public.sales_team_members m, w
  WHERE m.valid_from <= w.td AND coalesce(m.valid_to, 'infinity'::date) >= w.fd
  ORDER BY m.person_id, m.is_primary DESC, m.valid_from DESC
),
-- ── per person, this period ─────────────────────────────────────────────────
d_p AS (
  SELECT vw.person_id,
         count(*)                                                  AS worked,
         count(*) FILTER (WHERE vw.via = 'crm')                    AS via_crm,
         count(*) FILTER (WHERE vw.via = 'altercpa')               AS via_altercpa,
         count(*) FILTER (WHERE vw.outcome = 'sale')               AS sale,
         count(*) FILTER (WHERE vw.outcome = 'cancel')             AS cancel,
         count(*) FILTER (WHERE vw.outcome = 'trash')              AS trash,
         count(*) FILTER (WHERE vw.outcome = 'callback')           AS callback,
         max(vw.at)                                                AS last_decision_at
  FROM vw WHERE vw.cur AND vw.person_id IS NOT NULL GROUP BY 1
),
c_p AS (
  SELECT cl.person_id,
         count(*)                                                        AS call_logs,
         count(*) FILTER (WHERE cl.outcome = 'no_answer')                AS no_answer,
         count(*) FILTER (WHERE cl.started_at IS NOT NULL)               AS timed_calls,
         coalesce(sum(cl.total_seconds) FILTER (WHERE cl.started_at IS NOT NULL), 0) AS handling_sec
  FROM cl WHERE cl.cur AND cl.person_id IS NOT NULL GROUP BY 1
),
ev AS (                    -- every event a person made this period
  SELECT vw.person_id, vw.at, vw.lt FROM vw WHERE vw.cur AND vw.person_id IS NOT NULL
  UNION ALL
  SELECT cl.person_id, cl.at, cl.lt FROM cl WHERE cl.cur AND cl.person_id IS NOT NULL
),
evd AS (
  SELECT ev.person_id, ev.lt::date AS d, min(ev.lt) AS lo, max(ev.lt) AS hi
  FROM ev GROUP BY 1, 2
),
e_p AS (                   -- first / last event, days active, the average day's start and end
  SELECT a.person_id, a.first_at, a.last_at, b.days_active, b.avg_start_min, b.avg_end_min
  FROM (SELECT ev.person_id, min(ev.at) AS first_at, max(ev.at) AS last_at FROM ev GROUP BY 1) a
  JOIN (SELECT evd.person_id, count(*) AS days_active,
               round(avg(extract(epoch FROM evd.lo::time) / 60)) AS avg_start_min,
               round(avg(extract(epoch FROM evd.hi::time) / 60)) AS avg_end_min
        FROM evd GROUP BY 1) b ON b.person_id = a.person_id
),
t_p AS (                   -- decisions on days the person HAS presence (rates per active hour)
  SELECT vw.person_id,
         count(*)                                    AS worked_tracked,
         count(*) FILTER (WHERE vw.outcome = 'sale') AS sale_tracked
  FROM vw
  JOIN pr ON pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
  WHERE vw.cur
  GROUP BY 1
),
p_p AS (
  SELECT pr.person_id, count(*) AS presence_days,
         sum(pr.online_minutes) AS online_min, sum(pr.active_minutes) AS active_min,
         sum(pr.idle_minutes) AS idle_min, sum(pr.break_minutes) AS break_min,
         sum(pr.idle_alerts) AS idle_alerts,
         min(pr.first_active_at) AS first_active, max(pr.last_active_at) AS last_active
  FROM pr WHERE pr.cur GROUP BY 1
),
b_p AS (
  SELECT brk.person_id, count(*) AS breaks, round(sum(brk.mins)) AS break_logged_min
  FROM brk GROUP BY 1
),
sold AS (                  -- people a sale was credited to this period (sold_at is the stamp's
  SELECT DISTINCT o.sold_by_person_id AS person_id   -- own clock): they get a row even with no other
  FROM public.orders o, w                            -- trace; the COUNT comes from insights_work_credited
  WHERE o.sold_at BETWEEN w.f AND w.t AND o.sold_by_person_id IS NOT NULL
    AND ($6::uuid IS NULL OR o.sold_by_person_id = $7::uuid)
  UNION                      -- … and the authors of the period's collabBox bookings (cohort kind
  SELECT DISTINCT b.author_person_id                 -- 'booking', 20260942001900): a seller whose only
  FROM public.collabbox_documents b, w               -- sales are still waiting for their parcel gets
  WHERE b.doc_at >= w.f                              -- her row (a superset: a booking that is a CRM
    AND public.collabbox_sale_at(b.doc_at, b.booked_at) BETWEEN w.f AND w.t   -- the BOOKING day (20260944000600)
    AND b.author_person_id IS NOT NULL               -- sale's copy just shows 0 credited)
    AND b.outcome IN ('booked', 'awaiting_parcel') AND b.vanished_at IS NULL
    AND ($6::uuid IS NULL OR b.author_person_id = $7::uuid)
),
pn AS (                    -- the live state, the Overview's rule
  SELECT a.user_id,
         CASE WHEN a.last_state IN ('active', 'idle', 'break') AND a.last_seen_at >= now() - interval '3 minutes'
              THEN CASE a.last_state WHEN 'active' THEN 'online' ELSE a.last_state END
              ELSE 'offline' END AS st
  FROM public.agent_presence_days a
  WHERE a.day = (now() AT TIME ZONE 'Europe/Skopje')::date
),
ppl AS (                   -- anyone with a trace this period + every team member of the window
  SELECT d_p.person_id FROM d_p
  UNION SELECT c_p.person_id FROM c_p
  UNION SELECT p_p.person_id FROM p_p
  UNION SELECT b_p.person_id FROM b_p
  UNION SELECT sold.person_id FROM sold
  UNION SELECT mem.person_id FROM mem WHERE $6::uuid IS NULL
  UNION SELECT $7::uuid WHERE $7::uuid IS NOT NULL
),
pj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'person_id',        sp.id,
           'name',             sp.display_name,
           'has_login',        sp.user_id IS NOT NULL,
           'is_manager',       sp.is_manager,
           'is_active',        sp.is_active,
           'team_key',         coalesce(mem.team_key, 'unassigned'),
           'team_lane',        mem.lane,
           'role',             coalesce(mem.role, 'member'),
           'online_state',     CASE WHEN sp.user_id IS NULL THEN 'n/a' ELSE coalesce(pn.st, 'offline') END,
           'worked',           coalesce(d.worked, 0),
           'via_crm',          coalesce(d.via_crm, 0),
           'via_altercpa',     coalesce(d.via_altercpa, 0),
           'sale',             coalesce(d.sale, 0),
           'cancel',           coalesce(d.cancel, 0),
           'trash',            coalesce(d.trash, 0),
           'callback',         coalesce(d.callback, 0),
           'no_answer',        coalesce(c.no_answer, 0),
           'call_logs',        coalesce(c.call_logs, 0),
           'timed_calls',      coalesce(c.timed_calls, 0),
           'handling_sec',     coalesce(c.handling_sec, 0),
           'days_active',      coalesce(e.days_active, 0),
           'first_at',         e.first_at,
           'last_at',          e.last_at,
           'avg_start_min',    e.avg_start_min,
           'avg_end_min',      e.avg_end_min,
           'last_decision_at', d.last_decision_at,
           'worked_tracked',   coalesce(tt.worked_tracked, 0),
           'sale_tracked',     coalesce(tt.sale_tracked, 0),
           'presence_days',    coalesce(p.presence_days, 0),
           'online_min',       p.online_min,
           'active_min',       p.active_min,
           'idle_min',         p.idle_min,
           'break_min',        p.break_min,
           'idle_alerts',      p.idle_alerts,
           'first_active',     p.first_active,
           'last_active',      p.last_active,
           'breaks',           coalesce(b.breaks, 0),
           'break_logged_min', coalesce(b.break_logged_min, 0))
         ORDER BY coalesce(d.worked, 0) DESC, coalesce(c.call_logs, 0) DESC, sp.display_name), '[]'::jsonb) AS j
  FROM ppl
  JOIN public.sales_people sp ON sp.id = ppl.person_id
  LEFT JOIN mem ON mem.person_id = sp.id
  LEFT JOIN pn ON pn.user_id = sp.user_id
  LEFT JOIN d_p d ON d.person_id = sp.id
  LEFT JOIN c_p c ON c.person_id = sp.id
  LEFT JOIN e_p e ON e.person_id = sp.id
  LEFT JOIN t_p tt ON tt.person_id = sp.id
  LEFT JOIN p_p p ON p.person_id = sp.id
  LEFT JOIN b_p b ON b.person_id = sp.id
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('team_key', st.key, 'name', st.name, 'mode', st.leaderboard_mode,
                                                'kind', st.kind, 'sort_order', st.sort_order)
                            ORDER BY st.sort_order, st.key), '[]'::jsonb) AS j
  FROM public.sales_teams st
),
-- ── totals, this period and the previous one ────────────────────────────────
totj AS (
  SELECT jsonb_build_object(
    'worked',        (SELECT count(*) FROM vw WHERE vw.cur),
    'via_crm',       (SELECT count(*) FROM vw WHERE vw.cur AND vw.via = 'crm'),
    'via_altercpa',  (SELECT count(*) FROM vw WHERE vw.cur AND vw.via = 'altercpa'),
    'sale',          (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'sale'),
    'cancel',        (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'cancel'),
    'trash',         (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'trash'),
    'callback',      (SELECT count(*) FROM vw WHERE vw.cur AND vw.outcome = 'callback'),
    'no_answer',     (SELECT count(*) FROM cl WHERE cl.cur AND cl.outcome = 'no_answer'),
    'call_logs',     (SELECT count(*) FROM cl WHERE cl.cur),
    'timed_calls',   (SELECT count(*) FROM cl WHERE cl.cur AND cl.started_at IS NOT NULL),
    'handling_sec',  (SELECT coalesce(sum(cl.total_seconds), 0) FROM cl WHERE cl.cur AND cl.started_at IS NOT NULL),
    'people',        (SELECT count(DISTINCT ev.person_id) FROM ev),
    'people_crm',    (SELECT count(DISTINCT vw.person_id) FROM vw WHERE vw.cur AND vw.via = 'crm'),
    'people_altercpa', (SELECT count(DISTINCT vw.person_id) FROM vw WHERE vw.cur AND vw.via = 'altercpa'),
    'worked_tracked', (SELECT coalesce(sum(t_p.worked_tracked), 0) FROM t_p),
    'sale_tracked',  (SELECT coalesce(sum(t_p.sale_tracked), 0) FROM t_p),
    'presence_people', (SELECT count(*) FROM p_p),
    'online_min',    (SELECT sum(p_p.online_min) FROM p_p),
    'active_min',    (SELECT sum(p_p.active_min) FROM p_p),
    'idle_min',      (SELECT sum(p_p.idle_min) FROM p_p),
    'break_min',     (SELECT sum(p_p.break_min) FROM p_p),
    'idle_alerts',   (SELECT sum(p_p.idle_alerts) FROM p_p),
    'breaks',        (SELECT count(*) FROM brk),
    'break_logged_min', (SELECT coalesce(round(sum(brk.mins)), 0) FROM brk),
    'days_active',   (SELECT count(DISTINCT x.d) FROM (SELECT vw.lt::date AS d FROM vw WHERE vw.cur
                                                     UNION ALL SELECT cl.lt::date FROM cl WHERE cl.cur) x)
  ) AS j
),
prvj AS (
  SELECT CASE WHEN w.pf IS NULL THEN NULL ELSE jsonb_build_object(
    'worked',        (SELECT count(*) FROM vw WHERE NOT vw.cur),
    'via_crm',       (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.via = 'crm'),
    'via_altercpa',  (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.via = 'altercpa'),
    'sale',          (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'sale'),
    'cancel',        (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'cancel'),
    'trash',         (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'trash'),
    'callback',      (SELECT count(*) FROM vw WHERE NOT vw.cur AND vw.outcome = 'callback'),
    'no_answer',     (SELECT count(*) FROM cl WHERE NOT cl.cur AND cl.outcome = 'no_answer'),
    'call_logs',     (SELECT count(*) FROM cl WHERE NOT cl.cur),
    'timed_calls',   (SELECT count(*) FROM cl WHERE NOT cl.cur AND cl.started_at IS NOT NULL),
    'people',        (SELECT count(DISTINCT x.person_id) FROM (
                        SELECT vw.person_id FROM vw WHERE NOT vw.cur AND vw.person_id IS NOT NULL
                        UNION ALL SELECT cl.person_id FROM cl WHERE NOT cl.cur AND cl.person_id IS NOT NULL) x),
    'worked_tracked', (SELECT count(*) FROM vw JOIN pr ON NOT pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
                        WHERE NOT vw.cur),
    'sale_tracked',  (SELECT count(*) FROM vw JOIN pr ON NOT pr.cur AND pr.person_id = vw.person_id AND pr.day = vw.lt::date
                        WHERE NOT vw.cur AND vw.outcome = 'sale'),
    'presence_people', (SELECT count(DISTINCT pr.person_id) FROM pr WHERE NOT pr.cur),
    'online_min',    (SELECT sum(pr.online_minutes) FROM pr WHERE NOT pr.cur),
    'active_min',    (SELECT sum(pr.active_minutes) FROM pr WHERE NOT pr.cur),
    'idle_alerts',   (SELECT sum(pr.idle_alerts) FROM pr WHERE NOT pr.cur)
  ) END AS j
  FROM w
),
-- ── per day (or week) × team ────────────────────────────────────────────────
pd_ev AS (
  SELECT CASE WHEN w.gran = 'day' THEN vw.lt::date ELSE date_trunc('week', vw.lt)::date END AS b,
         CASE WHEN vw.person_id IS NULL THEN '__none__' ELSE coalesce(mem.team_key, 'unassigned') END AS team_key,
         vw.person_id, vw.outcome AS k
  FROM vw CROSS JOIN w LEFT JOIN mem ON mem.person_id = vw.person_id
  WHERE vw.cur
  UNION ALL
  SELECT CASE WHEN w.gran = 'day' THEN cl.lt::date ELSE date_trunc('week', cl.lt)::date END,
         CASE WHEN cl.person_id IS NULL THEN '__none__' ELSE coalesce(mem.team_key, 'unassigned') END,
         cl.person_id, CASE WHEN cl.outcome = 'no_answer' THEN 'no_answer' ELSE 'call' END
  FROM cl CROSS JOIN w LEFT JOIN mem ON mem.person_id = cl.person_id
  WHERE cl.cur
),
pd_pr AS (
  SELECT CASE WHEN w.gran = 'day' THEN pr.day ELSE date_trunc('week', pr.day)::date END AS b,
         coalesce(mem.team_key, 'unassigned') AS team_key,
         sum(pr.online_minutes) AS online_min, sum(pr.active_minutes) AS active_min
  FROM pr CROSS JOIN w LEFT JOIN mem ON mem.person_id = pr.person_id
  WHERE pr.cur
  GROUP BY 1, 2
),
pd AS (
  SELECT coalesce(e.b, p.b) AS b, coalesce(e.team_key, p.team_key) AS team_key,
         coalesce(e.worked, 0) AS worked, coalesce(e.sale, 0) AS sale, coalesce(e.cancel, 0) AS cancel,
         coalesce(e.trash, 0) AS trash, coalesce(e.callback, 0) AS callback,
         coalesce(e.no_answer, 0) AS no_answer, coalesce(e.calls, 0) AS calls,
         coalesce(e.people, 0) AS people,
         p.online_min, p.active_min
  FROM (
    SELECT pd_ev.b, pd_ev.team_key,
           count(*) FILTER (WHERE pd_ev.k IN ('sale', 'cancel', 'trash', 'callback')) AS worked,
           count(*) FILTER (WHERE pd_ev.k = 'sale')      AS sale,
           count(*) FILTER (WHERE pd_ev.k = 'cancel')    AS cancel,
           count(*) FILTER (WHERE pd_ev.k = 'trash')     AS trash,
           count(*) FILTER (WHERE pd_ev.k = 'callback')  AS callback,
           count(*) FILTER (WHERE pd_ev.k = 'no_answer') AS no_answer,
           count(*) FILTER (WHERE pd_ev.k IN ('no_answer', 'call')) AS calls,
           count(DISTINCT pd_ev.person_id)               AS people
    FROM pd_ev GROUP BY 1, 2
  ) e
  FULL JOIN pd_pr p ON p.b = e.b AND p.team_key = e.team_key
),
pdj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', to_char(pd.b, 'YYYY-MM-DD'), 'team_key', pd.team_key,
           'worked', pd.worked, 'sale', pd.sale, 'cancel', pd.cancel, 'trash', pd.trash,
           'callback', pd.callback, 'no_answer', pd.no_answer, 'call_logs', pd.calls,
           'people', pd.people,
           'online_min', pd.online_min, 'active_min', pd.active_min)
         ORDER BY pd.b, pd.team_key), '[]'::jsonb) AS j
  FROM pd
),
-- ── hour of day (Skopje) × person: the heat grid ───────────────────────────
hj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('p', x.person_id, 'h', x.h, 'd', x.dec, 'c', x.calls)
                            ORDER BY x.person_id, x.h), '[]'::jsonb) AS j
  FROM (
    SELECT e.person_id, extract(hour FROM e.lt)::int AS h,
           count(*) FILTER (WHERE e.src = 'd') AS dec,
           count(*) FILTER (WHERE e.src = 'c') AS calls
    FROM (SELECT vw.person_id, vw.lt, 'd'::text AS src FROM vw WHERE vw.cur
          UNION ALL SELECT cl.person_id, cl.lt, 'c'::text FROM cl WHERE cl.cur) e
    GROUP BY 1, 2
  ) x
),
-- ── the call-again queues, NOW (the Call Agains pool; 6-day window) ────────
cbj AS (
  SELECT jsonb_build_object(
    'leads', (
      SELECT jsonb_build_object(
        'total',        count(*),
        'unassigned',   count(*) FILTER (WHERE o.assigned_agent_id IS NULL),
        'over_24h',     count(*) FILTER (WHERE o.call_again_since < now() - interval '24 hours'),
        'expiring_24h', count(*) FILTER (WHERE o.call_again_since < now() - interval '5 days'),
        'no_since',     count(*) FILTER (WHERE o.call_again_since IS NULL),
        'oldest_since', min(o.call_again_since))
      FROM public.orders o
      WHERE o.status = 'call_again'
        AND public.is_lead_source(o.source_type)
        AND NOT public.insights_excluded8(public.insights_phone8(o.customer_phone), $5::text[])
        AND ($6::uuid IS NULL OR o.assigned_agent_id = $6::uuid)),
    'prediction', (
      SELECT jsonb_build_object(
        'total',        count(*),
        'unassigned',   count(*) FILTER (WHERE m.assigned_agent_id IS NULL),
        'over_24h',     count(*) FILTER (WHERE m.call_again_since < now() - interval '24 hours'),
        'expiring_24h', count(*) FILTER (WHERE m.call_again_since < now() - interval '5 days'),
        'no_since',     0,
        'oldest_since', min(m.call_again_since))
      FROM public.prediction_segment_members m
      WHERE m.call_again_since IS NOT NULL
        AND m.is_completed = false
        AND ($6::uuid IS NULL OR m.assigned_agent_id = $6::uuid)),
    'window_days', 6) AS j
),
-- ── data quality ────────────────────────────────────────────────────────────
pres_since AS (SELECT min(a.day) AS d FROM public.agent_presence_days a),
qj AS (
  SELECT CASE WHEN $6::uuid IS NOT NULL THEN NULL ELSE jsonb_build_object(
    'no_person',        (SELECT count(*) FROM vw WHERE vw.cur AND vw.person_id IS NULL),
    'no_person_top',    (SELECT coalesce(jsonb_agg(jsonb_build_object('via', y.via, 'ext', y.actor_ext, 'n', y.n)
                                                   ORDER BY y.n DESC, y.actor_ext), '[]'::jsonb)
                         FROM (SELECT vw.via, vw.actor_ext, count(*) AS n FROM vw
                               WHERE vw.cur AND vw.person_id IS NULL
                               GROUP BY 1, 2 ORDER BY 3 DESC, 2 LIMIT 5) y),
    'unmapped_calls',   (SELECT count(*) FROM cl WHERE cl.cur AND cl.person_id IS NULL),
    'unmapped_callers', (SELECT count(DISTINCT cl.agent_id) FROM cl WHERE cl.cur AND cl.person_id IS NULL),
    -- days of the window before presence tracking existed
    'days_before_presence', (SELECT greatest(0, least(w.td + 1, coalesce(ps.d, w.td + 1)) - w.fd) FROM w, pres_since ps),
    -- person-days worked by someone WITH a login, after tracking began, with no presence row
    'presence_gap_days', (SELECT count(*) FROM evd
                            JOIN public.sales_people sp ON sp.id = evd.person_id AND sp.user_id IS NOT NULL
                            CROSS JOIN pres_since ps
                           WHERE evd.d >= ps.d
                             AND NOT EXISTS (SELECT 1 FROM pr WHERE pr.cur AND pr.person_id = evd.person_id AND pr.day = evd.d)),
    -- AlterCPA-only operators: they decide in THEIR panel, no CRM presence exists for them
    'people_no_login',  (SELECT count(DISTINCT vw.person_id) FROM vw
                           JOIN public.sales_people sp ON sp.id = vw.person_id AND sp.user_id IS NULL
                          WHERE vw.cur)
  ) END AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'gran',           (SELECT w.gran FROM w),
    'presence_since', (SELECT to_char(ps.d, 'YYYY-MM-DD') FROM pres_since ps),
    'work_since',     least((SELECT min(h.changed_at) FROM public.order_history h),
                            (SELECT min(l.decided_at) FROM public.altercpa_leads l WHERE l.decision IS NOT NULL)),
    'calls_since',    (SELECT min(c.created_at) FROM public.call_logs c),
    'self',           $6::uuid IS NOT NULL,
    'credited_via',   'insights_work_credited'),
  'totals',    (SELECT totj.j FROM totj),
  'prev',      (SELECT prvj.j FROM prvj),
  'teams',     (SELECT tj.j FROM tj),
  'people',    (SELECT pj.j FROM pj),
  'per_day',   (SELECT pdj.j FROM pdj),
  'by_hour',   (SELECT hj.j FROM hj),
  'callbacks', (SELECT cbj.j FROM cbj),
  'quality',   (SELECT qj.j FROM qj))
$core$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_excluded, p_user_id, v_me;

  RETURN v_out;
END;
$function$;

-- ── 4. the order window: when the collabBox document was booked ─────────────
CREATE OR REPLACE FUNCTION public.order_origin(p_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT jsonb_build_object(
    'department', public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override),
    'sale_source', o.sale_source,
    'sale_source_detail', o.sale_source_detail,
    'doc_type', o.collabbox_doc_type,
    'intake', o.source_type,
    'seller', coalesce(sp.display_name,
                       CASE WHEN o.sold_by_ext ~ '^[0-9]+$' THEN NULL ELSE nullif(btrim(o.sold_by_ext), '') END),
    'sold_at', o.sold_at,
    'sold_via', o.sold_via,
    'paid_basis', o.paid_basis,
    'price_mkd', CASE WHEN o.price IS NULL THEN NULL ELSE round(o.price * 61.5) END,
    'parcel', (SELECT jsonb_build_object(
                 'tracking', p.tracking_id, 'account', p.account, 'series', p.series,
                 'status_id', p.status_id, 'status_name', p.status_name, 'cod_mkd', p.cod_mkd,
                 'receiver_name', p.receiver_name, 'receiver_city', p.receiver_city,
                 'created_at', p.created_at_mex, 'delivered_at', p.delivered_at,
                 'returned_at', p.returned_at, 'last_update_at', p.last_update_at,
                 'linked_here', p.order_id = o.id)
                 FROM public.mex_parcels p WHERE p.tracking_id = o.mex_tracking_id),
    'collabbox', (SELECT jsonb_build_object(
                    'doc', d.doc_number, 'type', d.doc_type_id, 'type_name', d.doc_type_name,
                    'author', d.author, 'doc_at', d.doc_at, 'amount_mkd', d.amount_mkd,
                    'booked_at', d.booked_at, 'booked_at_basis', d.booked_at_basis)
                    FROM public.collabbox_documents d
                   WHERE d.doc_number = o.mex_tracking_id AND d.vanished_at IS NULL),
    'altercpa', (SELECT jsonb_build_object(
                   'lead', l.altercpa_id, 'decision', l.decision, 'decided_at', l.decided_at,
                   'operator', coalesce(
                     (SELECT sp2.display_name FROM public.sales_person_identities i
                        JOIN public.sales_people sp2 ON sp2.id = i.person_id
                       WHERE i.kind = 'altercpa_user' AND i.value = l.decided_by_altercpa_user::text
                       LIMIT 1),
                     CASE WHEN l.decided_by_altercpa_user IS NOT NULL THEN '#' || l.decided_by_altercpa_user END))
                   FROM public.altercpa_leads l WHERE l.order_id = o.id
                   ORDER BY l.last_seen_at DESC NULLS LAST LIMIT 1))
    FROM public.orders o
    LEFT JOIN public.sales_people sp ON sp.id = o.sold_by_person_id
   WHERE o.id = p_id
$function$;

COMMIT;
