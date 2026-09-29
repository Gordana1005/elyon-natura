-- collabBox BOOKINGS count the moment they are booked (owner, 29.09.2026, answered explicitly):
--   "collabBox documents that are booked but have no MEX parcel yet (this morning 63 'Нарачка out' =
--    146.400 ден) must count IMMEDIATELY in the Overview and Operations — as a sale in the 'awaiting
--    parcel' part, in the department of the folder, credited to the agent who booked it. When the
--    parcel arrives it becomes an order and is counted once, never twice."
-- Agents book in collabBox during the day; the parcel — and so the order — appears hours later
-- (median ~19 h after the document, p99 ~70 h). The collabBox sync reads every 15 minutes.
--
--   insights_sale_rows   a new kind of cohort entry, 'booking' (next to 'order' · 'web' · 'mex'):
--                        bucket to_pack ("Во магацин за пакување"), split 'booked', person = the
--                        document's author, sale day = its doc_at (Skopje), value = its amount
--                        (денари), department = its folder's (collabbox_department → THE mapping;
--                        10114 LEADS-OUT = Affiliate – Lead out, 10050 = Телешоп – Lead out, 10036 =
--                        Телешоп – Lead in, 10106 / 10055 = social — owner 29.09 ~12:05, no author
--                        exception). Which documents, and why never twice: see the CTE comments
--                        (bk0 / bk) — no order holds the DocNumber, no parcel exists for it, not the
--                        copy of a CRM / AlterCPA sale (the writer's possible_twin_crm_sale, on the
--                        phone; the author's own sale within 10 minutes when no phone is known),
--                        still inside the writer's 14-day wait.
--   insights_cohort /    'booked' beside 'orders' / 'web' / 'mex_only' wherever a number says what it
--   insights_sales core  is made of — total.orders stays the real orders, so GET /orders drills keep
--                        listing exactly the order part (a booking is never an order).
--   insights_profit      the cohort strip's booked part (nb).
--   insights_returns     the base's booked part ('booked', 'base_booked').
--   insights_people      a booking is its author's sale (to pack); 'booked' per person / team / total
--                        (a person's /orders link is exact only without bookings); a booking with no
--                        person = an unmapped collabBox handle (no-seller reason 'unmapped').
--   insights_work_credited  a booking nobody is credited with is in no_seller too.
--   leaderboard_day_v2   the day's bookings ARE the cohort's booking rows — counted once, per person
--                        × department; the rest of collabbox_booked_today's documents are shown apart
--                        (booked_twin) as before.
-- Every body is the LIVE one (pg_get_functiondef, 29.09.2026, after 20260942001860) with counted,
-- exact edits; the drift guard refuses if another session changed any of them since. Payout / bonus
-- math untouched (deferred by the owner). The /orders twin (insightsCommon.ts) needs no change: a
-- booking never reaches /orders.

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', 'aab235f6df723b447bdb8f4d8d11dc94', 'c48795ea0cf5479505b43eaa73416bcb'),
    ('public.insights_cohort(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)', 'a97684433ab84750cfcce81a592c4a08', 'f58f7f52a36891bf95066bd932ef031b'),
    ('public.insights_sales(timestamp with time zone,timestamp with time zone,text,boolean,integer)', 'adc32e85cbe90e2da0dc60126b86fe51', '86bccf5c2030db13cd1a4b07552432db'),
    ('public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean)', 'a9f02625ac64906a057e557cf63ac6c1', '48ba64c02b7d06a6b13d5f740f7ac594'),
    ('public.insights_returns(timestamp with time zone,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,text[],boolean)', '62c7fda154de3bfdf4989c9801f96fba', 'e6bbd3a0f44009480b828fbe6c6eaf16'),
    ('public.insights_people(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)', '684644f35e8eaf73aa526d6e914009d0', '5e414eb23f34fd584e57b134bbda13ef'),
    ('public.insights_work_credited(timestamp with time zone,timestamp with time zone,uuid)', '3699959aeca5096d9f9205ea2af44090', '9a240b7c367aced4aff17c80a795c7da'),
    ('public.leaderboard_day_v2(date,text,text)', '6439b749f6b8980106712fd64ed2f741', '766f11de86dce386231f7ea3b93d6727')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'bookings in the cohort: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
END
$drift$;

-- public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)
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
mo AS MATERIALIZED (       -- MEX-only: no live web order, no real order holds it
  -- (a parcel a TEST order holds is that order's: counted nowhere either)
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.receiver_city, p.phone8,
         public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference) AS split
  FROM public.mex_parcels p
  WHERE p.created_at_mex BETWEEN $1 AND $2
    AND NOT public.insights_excluded8(p.phone8, $4)
    AND NOT EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id)
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
-- collabBox BOOKINGS (owner 29.09.2026, 20260942001900): an order document
-- booked in collabBox whose MEX parcel does not exist yet is a sale NOW — "to
-- pack" (Во магацин за пакување), in its FOLDER's department, credited to its
-- author. Its parcel turns it into an order (or a MEX-only parcel), counted
-- once, never twice. The ledger rows the writer (collabbox_apply_one) still
-- waits on: booked / awaiting_parcel, not vanished, no storno, not reversed, a
-- value, an ORDER type (10036 Нарачка in · 10050 Нарачка out · 10106 / 10055
-- social · 10114 LEADS-OUT; never 10111 LEADS — the shipping document of an
-- AlterCPA sale), at most 14 days old (the writer's own wait,
-- collabbox_retry_open) — and never a document an order holds or names, one
-- whose parcel exists (the parcel counts), one a web order claims, or a
-- komitent the writer skips (deceased, employee, …). p8 = the customer's
-- phone as the writer finds it: the komitent card → the teleshop registry →
-- any stored card.
bk0 AS MATERIALIZED (
  SELECT b.doc_number, b.doc_at, b.amount_mkd, b.goods_mkd, b.author_person_id,
         public.collabbox_department(b.doc_type_id, b.doc_number, b.author_person_id, b.doc_at) AS dep,
         coalesce(
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'),
           (SELECT t.phone8 FROM public.teleshop_import_customers t
             WHERE t.komitent_id = b.komitent_id AND t.phone8 ~ '^[0-9]{8}$'),
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.phone8 ~ '^[0-9]{8}$')) AS p8
  FROM public.collabbox_documents b
  WHERE b.doc_at BETWEEN $1 AND $2
    AND b.doc_at >= now() - interval '14 days'
    AND b.outcome IN ('booked', 'awaiting_parcel')
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.reversed_by IS NULL
    AND b.amount_mkd > 0
    AND b.doc_type_id IN ('10036', '10050', '10106', '10055', '10114')
    AND NOT EXISTS (SELECT 1 FROM public.orders x
                     WHERE x.external_source = 'collabbox' AND x.external_order_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.orders x WHERE x.mex_tracking_id = b.doc_number)
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p WHERE p.tracking_id = b.doc_number)
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
bkr AS (
  SELECT 'booking'::text AS kind,
         -- the folder's department: the twin of the order the document becomes
         public.cohort_order_source(bk.dep[1], bk.dep[2], bk.doc_number) AS source,
         'booked'::text AS split,
         bk.dep[1] AS sale_source,
         bk.doc_at AS sale_at,
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

-- public.insights_cohort(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,text[],boolean)
CREATE OR REPLACE FUNCTION public.insights_cohort(p_from timestamp with time zone, p_to_end timestamp with time zone, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_pfd  date;
  v_ptd  date;
  v_sfd  date;
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_cohort: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_cohort: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL
     AND p_prev_to_end >= p_prev_from AND p_prev_to_end - p_prev_from <= interval '800 days' THEN
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
    RAISE EXCEPTION 'insights_cohort: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_pfd  := (v_pf AT TIME ZONE 'Europe/Skopje')::date;
  v_ptd  := (v_pt AT TIME ZONE 'Europe/Skopje')::date;
  v_sfd  := CASE WHEN v_td - v_fd + 1 >= 14 THEN v_fd ELSE v_td - 13 END;
  v_gran := CASE WHEN v_td - v_sfd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from), (v_sfd::timestamp AT TIME ZONE 'Europe/Skopje'));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 from day · $7 to day · $8 spark first day · $9 spark granularity ·
  -- $10 prev from day · $11 prev to day · $12 all six sources · $13 the
  -- earliest instant any part needs (prev / spark)
  EXECUTE $co$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $6::date AS fd, $7::date AS td, $8::date AS sfd, $9::text AS sgran,
         $10::date AS pfd, $11::date AS ptd, $12::boolean AS all_src,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS sfmt,
         '&sold_from=' || to_char($6::date, 'YYYY-MM-DD') || '&sold_to=' || to_char($7::date, 'YYYY-MM-DD') AS win_q
),
srcs AS (
  SELECT s.key, s.ord, s.ss
  -- ss = the source's GET /orders cohort_source value (the api's twin of
  -- cohort_order_source(sale_source, sale_source_detail, mex_tracking_id): a
  -- department is not a sale_source list (20260942001000)
  FROM (VALUES ('altercpa', 1, 'altercpa'), ('elyon_crm', 2, 'elyon_crm'),
               ('teleshop_out', 3, 'teleshop_out'), ('teleshop_other', 4, 'teleshop_other'),
               ('social', 5, 'social'), ('web', 6, 'web')) s(key, ord, ss)
  CROSS JOIN prm
  WHERE s.key = ANY (prm.srcs)
),
-- '*' = every selected source; its cohort_source filter is omitted when all six are
scopes AS (
  SELECT '*'::text AS src, 0 AS ord,
         CASE WHEN (SELECT all_src FROM prm) THEN NULL
              ELSE (SELECT string_agg(s.ss, ',' ORDER BY s.ord) FROM srcs s) END AS ss
  UNION ALL
  SELECT s.key, s.ord, s.ss FROM srcs s
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1, true), ('paid_unproven', 2, true), ('paid_legacy', 3, true),
                        ('courier', 4, true), ('courier_problem', 5, true), ('label', 6, true),
                        ('to_pack', 7, true), ('returned', 8, true),
                        ('cancelled_after_sale', 9, false), ('trashed_after_sale', 10, false),
                        ('replacement', 11, false)) v(key, ord, in_total)
),
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.split, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.sale_day,
         r.q_cancelled_but_moving, r.q_no_seller, r.q_zero_cod, r.q_shared_parcel, r.q_double_count,
         (r.sale_at BETWEEN prm.f AND prm.t) AS cur,
         coalesce(r.sale_at BETWEEN prm.pf AND prm.pt, false) AS prev
  FROM public.insights_sale_rows($13, $2, false) r
  CROSS JOIN prm
  WHERE r.source = ANY (prm.srcs)
),
ag AS (                    -- (source | every source) × bucket, current and previous
  SELECT coalesce(r.source, '*') AS src, r.bucket,
         count(*) FILTER (WHERE r.cur)                        AS n,
         coalesce(sum(r.value_mkd) FILTER (WHERE r.cur), 0)   AS v,
         coalesce(sum(r.cod_mkd)   FILTER (WHERE r.cur), 0)   AS c,
         count(*) FILTER (WHERE r.cur AND r.kind = 'order')   AS n_order,
         count(*) FILTER (WHERE r.cur AND r.kind = 'web')     AS n_web,
         count(*) FILTER (WHERE r.cur AND r.kind = 'mex')     AS n_mex,
         count(*) FILTER (WHERE r.cur AND r.kind = 'booking') AS n_booking,
         count(*) FILTER (WHERE r.prev)                       AS pn,
         coalesce(sum(r.value_mkd) FILTER (WHERE r.prev), 0)  AS pv,
         coalesce(sum(r.cod_mkd)   FILTER (WHERE r.prev), 0)  AS pc
  FROM sr r
  WHERE r.cur OR r.prev
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
bx AS (                    -- every scope × every bucket, zero-filled
  SELECT sc.src, sc.ord AS sord, sc.ss, b.key, b.ord, b.in_total,
         coalesce(a.n, 0) AS n, coalesce(a.v, 0) AS v, coalesce(a.c, 0) AS c,
         coalesce(a.n_order, 0) AS n_order, coalesce(a.n_web, 0) AS n_web, coalesce(a.n_mex, 0) AS n_mex,
         coalesce(a.n_booking, 0) AS n_booking,
         coalesce(a.pn, 0) AS pn, coalesce(a.pv, 0) AS pv, coalesce(a.pc, 0) AS pc
  FROM scopes sc
  CROSS JOIN bks b
  LEFT JOIN ag a ON a.src = sc.src AND a.bucket = b.key
),
bj AS (
  SELECT x.src,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS buckets,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE NOT x.in_total) AS outside,
    jsonb_build_object(
      'count', coalesce(sum(x.n) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.v) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.c) FILTER (WHERE x.in_total), 0)),
      'orders', coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0),
      'web', coalesce(sum(x.n_web) FILTER (WHERE x.in_total), 0),
      'mex_only', coalesce(sum(x.n_mex) FILTER (WHERE x.in_total), 0),
      'booked', coalesce(sum(x.n_booking) FILTER (WHERE x.in_total), 0),
      'drill', CASE WHEN coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0) > 0 THEN
                 '/orders?cohort_bucket=total' || coalesce('&cohort_source=' || max(x.ss), '') || max(prm.win_q) END) AS total,
    jsonb_build_object(
      'count', coalesce(sum(x.pn) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.pv) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.pc) FILTER (WHERE x.in_total), 0))) AS prev_total,
    jsonb_agg(jsonb_build_object('key', x.key, 'count', x.pn, 'value_mkd', round(x.pv), 'cod_mkd', round(x.pc))
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS prev_buckets
  FROM bx x
  CROSS JOIN prm
  GROUP BY x.src
),
sp AS (                    -- splits: what each source's total is made of
  SELECT r.source, r.split, r.kind, count(*) AS n, sum(r.value_mkd) AS v
  FROM sr r
  WHERE r.cur AND r.in_total
  GROUP BY r.source, r.split, r.kind
),
spj AS (
  SELECT sp.source,
    jsonb_agg(jsonb_build_object(
      'key', sp.split, 'kind', sp.kind, 'count', sp.n, 'value_mkd', round(sp.v),
      -- only a detail GET /orders accepts (overview.ts DETAIL_RE) links
      'drill', CASE WHEN sp.kind = 'order' AND sp.split <> 'none' AND sp.split ~* '^[a-z0-9_.-]{1,40}$' THEN
                 '/orders?cohort_bucket=total&cohort_source=' || s.ss || '&sale_source_detail=' || sp.split || prm.win_q END)
      ORDER BY sp.n DESC, sp.split) AS j
  FROM sp
  JOIN srcs s ON s.key = sp.source
  CROSS JOIN prm
  GROUP BY sp.source
),
lr AS MATERIALIZED (
  SELECT l.source, l.state, l.disposition
  FROM public.insights_leads_rows($1, $2) l
  CROSS JOIN prm
  WHERE l.source = ANY (prm.srcs)
),
la AS (                    -- a partition: sales + cancelled + trashed + open + other = came_in
  SELECT coalesce(l.source, '*') AS src,
         count(*)                                         AS came_in,
         count(*) FILTER (WHERE l.state = 'sale')         AS sales,
         count(*) FILTER (WHERE l.state = 'cancelled')    AS cancelled,
         count(*) FILTER (WHERE l.state = 'trashed')      AS trashed,
         count(*) FILTER (WHERE l.state = 'open')         AS open,
         count(*) FILTER (WHERE l.state = 'other')        AS other,
         count(*) FILTER (WHERE l.disposition)            AS dispo
  FROM lr l
  GROUP BY GROUPING SETS ((l.source), ())
),
laj AS (
  SELECT sc.src, jsonb_build_object(
    'came_in',      coalesce(la.came_in, 0),
    'became_sales', coalesce(la.sales, 0),
    'cancelled',    coalesce(la.cancelled, 0),
    'trashed',      coalesce(la.trashed, 0),
    'open',         coalesce(la.open, 0),
    'other',        coalesce(la.other, 0),
    'disposition',  coalesce(la.dispo, 0),
    'conversion',   CASE WHEN coalesce(la.came_in, 0) > 0 THEN round(la.sales::numeric / la.came_in, 4) END) AS j
  FROM scopes sc
  LEFT JOIN la ON la.src = sc.src
),
cr AS MATERIALIZED (
  SELECT c.tracking_id, c.cod_mkd, c.card_mkd, c.sale_at
  FROM public.insights_cash_rows($1, $2) c
  CROSS JOIN prm
  WHERE c.source = ANY (prm.srcs)
),
cfj AS (
  SELECT jsonb_build_object(
    'parcels',     count(c.tracking_id),
    'cod_mkd',     round(coalesce(sum(c.cod_mkd), 0)),
    'card_mkd',    round(coalesce(sum(c.card_mkd), 0)),
    'card_orders', count(*) FILTER (WHERE c.card_mkd > 0),
    'from_this_period_mkd', round(coalesce(sum(coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))
                                   FILTER (WHERE c.sale_at BETWEEN prm.f AND prm.t), 0)),
    'from_earlier_mkd',     round(coalesce(sum(coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))
                                   FILTER (WHERE c.sale_at IS NULL OR NOT (c.sale_at BETWEEN prm.f AND prm.t)), 0))) AS j
  FROM prm
  LEFT JOIN cr c ON true
  GROUP BY prm.f, prm.t
),
sk AS (
  SELECT to_char(g, prm.sfmt) AS d
  FROM prm, generate_series(date_trunc(prm.sgran, prm.sfd::timestamp), date_trunc(prm.sgran, prm.td::timestamp),
                            ('1 ' || prm.sgran)::interval) g
),
sv AS (
  SELECT to_char(date_trunc(prm.sgran, r.sale_day::timestamp), prm.sfmt) AS d, count(*) AS n, sum(r.value_mkd) AS v
  FROM sr r CROSS JOIN prm
  WHERE r.in_total AND r.sale_day BETWEEN prm.sfd AND prm.td
  GROUP BY 1
),
skj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', sk.d, 'count', coalesce(sv.n, 0), 'value_mkd', round(coalesce(sv.v, 0)))
                            ORDER BY sk.d), '[]'::jsonb) AS j
  FROM sk LEFT JOIN sv ON sv.d = sk.d
),
qj AS (
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'unproven_paid',
      'count', count(*) FILTER (WHERE r.bucket = 'paid_unproven'),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.bucket = 'paid_unproven'), 0))),
    jsonb_build_object('kind', 'zero_cod_parcels',
      'count', count(*) FILTER (WHERE r.q_zero_cod),
      'value_mkd', round(coalesce(sum(r.cod_mkd) FILTER (WHERE r.q_zero_cod), 0))),
    -- a shared parcel is NOT a candidate: the owner ruled both orders
    -- accurate and its COD is split, not doubled (checker C8a exception)
    jsonb_build_object('kind', 'double_count_candidates',
      'count', count(*) FILTER (WHERE r.q_double_count),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_double_count), 0))),
    jsonb_build_object('kind', 'no_seller',
      'count', count(*) FILTER (WHERE r.q_no_seller),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_no_seller), 0))),
    jsonb_build_object('kind', 'cancelled_but_moving',
      'count', count(*) FILTER (WHERE r.q_cancelled_but_moving),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_cancelled_but_moving), 0)))) AS j
  FROM sr r
  WHERE r.cur
),
bsj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'key',       s.key,
    'total',     b.total,
    'buckets',   b.buckets,
    'outside',   b.outside,
    'splits',    coalesce(sj.j, '[]'::jsonb),
    'leads_in',  l.j) ORDER BY s.ord), '[]'::jsonb) AS j
  FROM srcs s
  JOIN bj b ON b.src = s.key
  JOIN laj l ON l.src = s.key
  LEFT JOIN spj sj ON sj.source = s.key
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from',         to_char(prm.fd, 'YYYY-MM-DD'),
    'to',           to_char(prm.td, 'YYYY-MM-DD'),
    'prev_from',    to_char(prm.pfd, 'YYYY-MM-DD'),
    'prev_to',      to_char(prm.ptd, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money',        true,
    'clock',        'sale',
    'sources',      to_jsonb(ARRAY(SELECT s.key FROM srcs s ORDER BY s.ord)),
    'granularity',  prm.sgran),
  'total',     b.total,
  'buckets',   b.buckets,
  'outside',   b.outside,
  'by_source', (SELECT j FROM bsj),
  'leads_in',  (SELECT l.j FROM laj l WHERE l.src = '*'),
  'cash_flow', (SELECT j FROM cfj),
  'prev',      CASE WHEN prm.pf IS NULL THEN NULL
                    ELSE jsonb_build_object('total', b.prev_total, 'buckets', b.prev_buckets) END,
  'spark',     (SELECT j FROM skj),
  'quality',   (SELECT j FROM qj))
FROM prm
JOIN bj b ON b.src = '*'
  $co$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_fd, v_td, v_sfd, v_gran, v_pfd, v_ptd,
        (v_src @> v_all), v_lo;

  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

-- public.insights_sales(timestamp with time zone,timestamp with time zone,text,boolean,integer)
CREATE OR REPLACE FUNCTION public.insights_sales(p_from timestamp with time zone, p_to_end timestamp with time zone, p_part text DEFAULT 'core'::text, p_money boolean DEFAULT false, p_top integer DEFAULT 40)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_part text := lower(coalesce(nullif(btrim(p_part), ''), 'core'));
  v_fd   date;
  v_td   date;
  v_gran text;
  v_top  integer := least(greatest(coalesce(p_top, 40), 5), 200);
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sales: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sales: bad window' USING ERRCODE = '22023';
  END IF;
  IF v_part NOT IN ('core', 'detail', 'summary') THEN
    RAISE EXCEPTION 'insights_sales: unknown part %', v_part USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day'
                 WHEN v_td - v_fd + 1 <= 190 THEN 'week'
                 ELSE 'month' END;

  -- $1 from · $2 to_end · $3 from day · $4 to day · $5 trend granularity ·
  -- $6 top N rows (products, cities) · $7 money (ranks by денари, else by
  -- packages — a non-owner's order never leaks the money ranking)
  IF v_part = 'core' THEN
    EXECUTE $core$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::date AS fd, $4::date AS td, $5::text AS gran,
         '&sold_from=' || to_char($3::date, 'YYYY-MM-DD') || '&sold_to=' || to_char($4::date, 'YYYY-MM-DD') AS win_q
),
srcs AS (
  -- ss = the source's GET /orders cohort_source value (insights_cohort's twin)
  SELECT * FROM (VALUES ('altercpa', 1, 'altercpa'), ('elyon_crm', 2, 'elyon_crm'),
                        ('teleshop_out', 3, 'teleshop_out'), ('teleshop_other', 4, 'teleshop_other'),
                        ('social', 5, 'social'), ('web', 6, 'web')) v(key, ord, ss)
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1, true), ('paid_unproven', 2, true), ('paid_legacy', 3, true),
                        ('courier', 4, true), ('courier_problem', 5, true), ('label', 6, true),
                        ('to_pack', 7, true), ('returned', 8, true),
                        ('cancelled_after_sale', 9, false), ('trashed_after_sale', 10, false),
                        ('replacement', 11, false)) v(key, ord, in_total)
),
-- THE cohort rows (foundation), once
r AS MATERIALIZED (
  SELECT s.kind, s.source, s.split, s.sale_source, s.sale_at, s.sale_day, s.bucket, s.in_total, s.value_mkd, s.cod_mkd,
         s.mex_account, s.mex_series, s.tracking_id,
         s.q_cancelled_but_moving, s.q_no_seller, s.q_zero_cod, s.q_double_count
  FROM public.insights_sale_rows($1, $2, false) s
),
-- ── the cohort block: the twin of insights_cohort's `ag` … `bj` ──────────
ag AS (
  SELECT coalesce(r.source, '*') AS src, r.bucket,
         count(*)                                   AS n,
         coalesce(sum(r.value_mkd), 0)              AS v,
         coalesce(sum(r.cod_mkd), 0)                AS c,
         count(*) FILTER (WHERE r.kind = 'order')   AS n_order,
         count(*) FILTER (WHERE r.kind = 'web')     AS n_web,
         count(*) FILTER (WHERE r.kind = 'mex')     AS n_mex,
         count(*) FILTER (WHERE r.kind = 'booking') AS n_booking
  FROM r
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
scopes AS (
  SELECT '*'::text AS src, 0 AS ord, NULL::text AS ss
  UNION ALL
  SELECT s.key, s.ord, s.ss FROM srcs s
),
bx AS (
  SELECT sc.src, sc.ss, b.key, b.ord, b.in_total,
         coalesce(a.n, 0) AS n, coalesce(a.v, 0) AS v, coalesce(a.c, 0) AS c,
         coalesce(a.n_order, 0) AS n_order, coalesce(a.n_web, 0) AS n_web, coalesce(a.n_mex, 0) AS n_mex,
         coalesce(a.n_booking, 0) AS n_booking
  FROM scopes sc
  CROSS JOIN bks b
  LEFT JOIN ag a ON a.src = sc.src AND a.bucket = b.key
),
bj AS (
  SELECT x.src,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v), 'cod_mkd', round(x.c),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE x.in_total) AS buckets,
    jsonb_agg(jsonb_build_object(
      'key', x.key, 'count', x.n, 'value_mkd', round(x.v),
      'orders', x.n_order, 'web', x.n_web, 'mex_only', x.n_mex, 'booked', x.n_booking,
      'drill', CASE WHEN x.n_order > 0 THEN
                 '/orders?cohort_bucket=' || x.key || coalesce('&cohort_source=' || x.ss, '') || prm.win_q END)
      ORDER BY x.ord) FILTER (WHERE NOT x.in_total) AS outside,
    jsonb_build_object(
      'count', coalesce(sum(x.n) FILTER (WHERE x.in_total), 0),
      'value_mkd', round(coalesce(sum(x.v) FILTER (WHERE x.in_total), 0)),
      'cod_mkd', round(coalesce(sum(x.c) FILTER (WHERE x.in_total), 0)),
      'orders', coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0),
      'web', coalesce(sum(x.n_web) FILTER (WHERE x.in_total), 0),
      'mex_only', coalesce(sum(x.n_mex) FILTER (WHERE x.in_total), 0),
      'booked', coalesce(sum(x.n_booking) FILTER (WHERE x.in_total), 0),
      'drill', CASE WHEN coalesce(sum(x.n_order) FILTER (WHERE x.in_total), 0) > 0 THEN
                 '/orders?cohort_bucket=total' || coalesce('&cohort_source=' || max(x.ss), '') || max(prm.win_q) END) AS total
  FROM bx x
  CROSS JOIN prm
  GROUP BY x.src
),
spj AS (                   -- splits: what each source's total is made of
  SELECT sp.source,
    jsonb_agg(jsonb_build_object(
      'key', sp.split, 'kind', sp.kind, 'count', sp.n, 'value_mkd', round(sp.v),
      'drill', CASE WHEN sp.kind = 'order' AND sp.split <> 'none' AND sp.split ~* '^[a-z0-9_.-]{1,40}$' THEN
                 '/orders?cohort_bucket=total&cohort_source=' || s.ss || '&sale_source_detail=' || sp.split || prm.win_q END)
      ORDER BY sp.n DESC, sp.split) AS j
  FROM (SELECT r.source, r.split, r.kind, count(*) AS n, sum(r.value_mkd) AS v
          FROM r WHERE r.in_total GROUP BY r.source, r.split, r.kind) sp
  JOIN srcs s ON s.key = sp.source
  CROSS JOIN prm
  GROUP BY sp.source
),
-- ── trend by source (sale day; day ≤ 62 days, week ≤ 190, else month) ────
tk AS (
  SELECT to_char(g, 'YYYY-MM-DD') AS d
  FROM prm, generate_series(date_trunc(prm.gran, prm.fd::timestamp), date_trunc(prm.gran, prm.td::timestamp),
                            ('1 ' || prm.gran)::interval) g
),
tv AS MATERIALIZED (
  SELECT to_char(date_trunc(prm.gran, r.sale_day::timestamp), 'YYYY-MM-DD') AS d, r.source,
         count(*) AS n, sum(r.value_mkd) AS v
  FROM r CROSS JOIN prm
  WHERE r.in_total
  GROUP BY 1, 2
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'd', tk.d,
           'count', coalesce((SELECT sum(tv.n) FROM tv WHERE tv.d = tk.d), 0),
           'value_mkd', round(coalesce((SELECT sum(tv.v) FROM tv WHERE tv.d = tk.d), 0)),
           'by_source', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'count', coalesce(tv.n, 0),
                                                             'value_mkd', round(coalesce(tv.v, 0)))
                                          ORDER BY s.ord)
                           FROM srcs s LEFT JOIN tv ON tv.d = tk.d AND tv.source = s.key))
           ORDER BY tk.d), '[]'::jsonb) AS j
  FROM tk
),
-- ── MEX account / series: the channel a parcel names ─────────────────────
chs AS (
  SELECT CASE WHEN r.tracking_id IS NULL THEN NULL ELSE coalesce(r.mex_account, 'unknown') END AS account,
         CASE WHEN r.tracking_id IS NULL      THEN 'none'
              WHEN r.mex_series IS NOT NULL   THEN r.mex_series
              WHEN r.tracking_id ~ '^NTMK'    THEN 'ntmk'
              WHEN r.tracking_id ~ '^M[0-9]'  THEN 'm'
              ELSE 'other' END AS chan,
         r.source,
         count(*) AS n, coalesce(sum(r.value_mkd), 0) AS v, coalesce(sum(r.cod_mkd), 0) AS c,
         count(*) FILTER (WHERE r.bucket IN ('paid', 'paid_legacy', 'paid_unproven'))    AS paid,
         count(*) FILTER (WHERE r.bucket IN ('courier', 'courier_problem', 'label'))     AS courier,
         count(*) FILTER (WHERE r.bucket = 'to_pack')                                    AS to_pack,
         count(*) FILTER (WHERE r.bucket = 'returned')                                   AS returned
  FROM r
  WHERE r.in_total
  GROUP BY 1, 2, 3
),
chj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'account', c.account, 'series', c.chan,
           'count', c.n, 'value_mkd', round(c.v), 'cod_mkd', round(c.c),
           'paid', c.paid, 'courier', c.courier, 'to_pack', c.to_pack, 'returned', c.returned,
           'by_source', c.bs)
           ORDER BY (c.chan = 'none'), c.n DESC, c.account, c.chan), '[]'::jsonb) AS j
  FROM (
    SELECT x.account, x.chan, sum(x.n) AS n, sum(x.v) AS v, sum(x.c) AS c,
           sum(x.paid) AS paid, sum(x.courier) AS courier, sum(x.to_pack) AS to_pack, sum(x.returned) AS returned,
           jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n) ORDER BY s.ord) AS bs
    FROM chs x
    JOIN srcs s ON s.key = x.source
    GROUP BY x.account, x.chan
  ) c
),
-- ── when we sell: weekday × hour (Skopje). Only sales that carry a real
-- moment — an agent's decision (AlterCPA intake, a CRM sale) and web
-- checkouts. collabBox orders carry a date only (imported at 09:00) and a
-- MEX-only parcel's time is its label, not a sale: they are counted apart,
-- never smeared into the grid. By the ORDER's own sale_source, never its
-- department: a CRM sale shipped on a teleshop parcel is still a timed CRM
-- decision (20260942001000); the timed set is exactly the pre-six-department one.
tmr AS MATERIALIZED (
  SELECT r.kind, r.source, r.sale_at, r.sale_day, r.value_mkd,
         (r.kind = 'web' OR (r.kind = 'order' AND r.sale_source IN ('altercpa', 'affiliate', 'elyon_crm')
                             AND r.split NOT IN ('collabbox_out', 'collabbox_leads_out', 'team_collabbox_out', 'team_collabbox_leads_out', 'collabbox_leads'))) AS timed
  FROM r
  WHERE r.in_total
),
tmj AS (
  SELECT jsonb_build_object(
    'cells', (SELECT coalesce(jsonb_agg(jsonb_build_object('dow', c.dow, 'hour', c.h, 'count', c.n, 'value_mkd', round(c.v))
                                        ORDER BY c.dow, c.h), '[]'::jsonb)
                FROM (SELECT extract(isodow FROM tmr.sale_at AT TIME ZONE 'Europe/Skopje')::int AS dow,
                             extract(hour FROM tmr.sale_at AT TIME ZONE 'Europe/Skopje')::int AS h,
                             count(*) AS n, sum(tmr.value_mkd) AS v
                        FROM tmr WHERE tmr.timed GROUP BY 1, 2) c),
    'timed', (SELECT count(*) FROM tmr WHERE tmr.timed),
    'untimed', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', u.key, 'kind', u.kind, 'count', u.n) ORDER BY u.n DESC), '[]'::jsonb)
                  FROM (SELECT tmr.source AS key, tmr.kind, count(*) AS n FROM tmr WHERE NOT tmr.timed
                         GROUP BY tmr.source, tmr.kind) u),
    -- every sale by its sale day's weekday, with how many such days the period has
    'weekdays', (SELECT jsonb_agg(jsonb_build_object('dow', g.dow, 'count', coalesce(w.n, 0), 'value_mkd', round(coalesce(w.v, 0)),
                                                     'days', coalesce(dd.days, 0))
                                  ORDER BY g.dow)
                   FROM generate_series(1, 7) g(dow)
                   LEFT JOIN (SELECT extract(isodow FROM tmr.sale_day)::int AS dow, count(*) AS n, sum(tmr.value_mkd) AS v
                                FROM tmr GROUP BY 1) w ON w.dow = g.dow
                   LEFT JOIN (SELECT extract(isodow FROM d)::int AS dow, count(*) AS days
                                FROM prm, generate_series(prm.fd::timestamp, prm.td::timestamp, interval '1 day') d
                               GROUP BY 1) dd ON dd.dow = g.dow)) AS j
),
-- ── quality: the cohort's five, exactly as insights_cohort counts them ────
qj AS (
  SELECT jsonb_build_array(
    jsonb_build_object('kind', 'unproven_paid',
      'count', count(*) FILTER (WHERE r.bucket = 'paid_unproven'),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.bucket = 'paid_unproven'), 0))),
    jsonb_build_object('kind', 'zero_cod_parcels',
      'count', count(*) FILTER (WHERE r.q_zero_cod),
      'value_mkd', round(coalesce(sum(r.cod_mkd) FILTER (WHERE r.q_zero_cod), 0))),
    jsonb_build_object('kind', 'double_count_candidates',
      'count', count(*) FILTER (WHERE r.q_double_count),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_double_count), 0))),
    jsonb_build_object('kind', 'no_seller',
      'count', count(*) FILTER (WHERE r.q_no_seller),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_no_seller), 0))),
    jsonb_build_object('kind', 'cancelled_but_moving',
      'count', count(*) FILTER (WHERE r.q_cancelled_but_moving),
      'value_mkd', round(coalesce(sum(r.value_mkd) FILTER (WHERE r.q_cancelled_but_moving), 0)))) AS j
  FROM r
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char(prm.fd, 'YYYY-MM-DD'),
    'to', to_char(prm.td, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money', true,
    'clock', 'sale',
    'part', 'core',
    'granularity', prm.gran),
  'total',     b0.total,
  'buckets',   b0.buckets,
  'outside',   b0.outside,
  'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                  'key', s.key, 'total', bs.total, 'buckets', bs.buckets, 'outside', bs.outside,
                  'splits', coalesce(sj.j, '[]'::jsonb)) ORDER BY s.ord), '[]'::jsonb)
                FROM srcs s JOIN bj bs ON bs.src = s.key LEFT JOIN spj sj ON sj.source = s.key),
  'trend',     jsonb_build_object('granularity', prm.gran, 'points', (SELECT j FROM tj)),
  'channels',  (SELECT j FROM chj),
  'timing',    (SELECT j FROM tmj),
  'quality',   (SELECT j FROM qj))
FROM prm
JOIN bj b0 ON b0.src = '*'
$core$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  ELSIF v_part = 'detail' THEN
    EXECUTE $detail$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::date AS fd, $4::date AS td,
         $6::integer AS topn, $7::boolean AS money
),
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                        ('social', 5), ('web', 6)) v(key, ord)
),
-- THE cohort's sales (foundation) + the city the foundation would key them
-- by — its twin: the owned parcel's receiver_city (tracking_id is set only
-- when the sale owns a parcel), else the order's / web order's own city.
-- rid = a row id the line rows carry.
rt AS MATERIALIZED (
  SELECT row_number() OVER () AS rid,
         s.kind, s.source, s.sale_source, s.bucket, s.value_mkd, s.order_id, s.web_id, s.tracking_id,
         CASE WHEN s.phone8 ~ '^[0-9]{8}$' THEN s.phone8 END AS phone8,
         coalesce(nullif(btrim(p.receiver_city), ''),
                  CASE WHEN s.kind = 'order' THEN
                         (SELECT nullif(btrim(o.customer_city), '') FROM public.orders o WHERE o.id = s.order_id)
                       WHEN s.kind = 'web' THEN
                         (SELECT nullif(btrim(w.city), '') FROM public.web_orders w WHERE w.shop_order_id = s.web_id)
                  END) AS city_raw
  FROM public.insights_sale_rows($1, $2, false) s
  LEFT JOIN public.mex_parcels p ON p.tracking_id = s.tracking_id
  WHERE s.in_total
),
-- ── products: every line of every sale; the sale's value is spread over its
-- lines so Σ products + Σ other lines + Σ sales with no line = the total ──
ln0 AS MATERIALIZED (
  SELECT rt.rid, rt.source, rt.bucket, rt.value_mkd, oi.id::text AS lid,
         CASE WHEN rt.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_id AS pid, oi.product_name AS name,
         greatest(coalesce(oi.quantity, 0), 0) AS qty,
         greatest(coalesce(oi.total_price, 0), 0)::numeric AS w,
         NULL::text AS shop_kind
  FROM rt
  JOIN public.order_items oi ON oi.order_id = rt.order_id
  WHERE rt.kind = 'order'
  UNION ALL
  SELECT rt.rid, rt.source, rt.bucket, rt.value_mkd, 'w' || i.shop_item_id::text,
         'web', NULL::uuid, i.name,
         greatest(coalesce(i.quantity, 0), 0),
         greatest(coalesce(i.price, 0) * coalesce(i.quantity, 0) - coalesce(i.discount_allocated, 0), 0)::numeric,
         i.kind
  FROM rt
  JOIN public.web_order_items i ON i.shop_order_id = rt.web_id
  WHERE rt.kind = 'web'
),
-- the product key and the reviewed kind, once per distinct line — as ONE map
-- (a lookup per line, never a join the planner can mis-size)
lkm AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(d.k, jsonb_build_array(
           coalesce(public.product_key(d.src, d.name, d.pid), '__unknown__'),
           public.order_line_kind(d.src, d.name))), '{}'::jsonb) AS m
  FROM (SELECT DISTINCT l.src || chr(1) || coalesce(l.name, '') || chr(1) || coalesce(l.pid::text, '') AS k,
               l.src, l.name, l.pid
          FROM ln0 l) d
),
ln1 AS MATERIALIZED (   -- the kind is decided once per line (it feeds four window sums)
  SELECT l.*, x.pkey,
         CASE
           -- a reviewed alias (product_aliases) says what the line is
           WHEN x.akind IS DISTINCT FROM 'product'                                        THEN x.akind
           WHEN l.shop_kind = 'GIFT'                                                      THEN 'gift'
           WHEN lower(coalesce(l.name, '')) ~ '^\s*(поен|poen)(и|i)?([^[:alpha:]]|$)'     THEN 'loyalty_point'
           WHEN lower(coalesce(l.name, '')) ~ '^\s*(достава|dostava|delivery|shipping)([^[:alpha:]]|$)' THEN 'delivery'
           ELSE 'product' END AS kind0,
         (x.akind IS DISTINCT FROM 'product') AS by_alias
  FROM ln0 l
  CROSS JOIN LATERAL (
    SELECT e ->> 0 AS pkey, e ->> 1 AS akind
    FROM (SELECT (SELECT lkm.m FROM lkm) -> (l.src || chr(1) || coalesce(l.name, '') || chr(1) || coalesce(l.pid::text, '')) AS e) q
  ) x
),
-- ONE sort per sale. The weight is the line's money (sw > 0); a sale valued
-- at COD with no priced line spreads over its product units instead. Running
-- sums allocate by the cumulative method, so a sale's lines add up to its
-- value to the denar: Σ (round(V·c/T) − round(V·(c − a)/T)) = round(V) = V.
ln2 AS (
  SELECT l.*,
         (CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END)::numeric AS pq,
         sum(l.w) OVER wp AS sw,
         sum(l.w) OVER wr AS cw,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wp AS sq,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wr AS cq
  FROM ln1 l
  WINDOW wp AS (PARTITION BY l.rid),
         wr AS (PARTITION BY l.rid ORDER BY l.w DESC, (l.kind0 = 'product') DESC, l.qty DESC, l.lid
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
lv AS MATERIALIZED (
  SELECT z.*,
         -- a package count no price supports (1.000 at 48,78 €) is a typing
         -- slip: the line keeps its money, its units are left out and reported
         (z.lkind = 'product' AND z.qty > 20 AND z.val < 60 * z.qty) AS bad_qty
  FROM (
    SELECT l.rid, l.pkey, l.by_alias, l.qty, l.name, l.source, l.bucket, l.value_mkd,
           -- a free unit of a product on a paid sale is a gift
           CASE WHEN l.kind0 = 'product' AND l.w = 0 AND l.sw > 0 THEN 'gift' ELSE l.kind0 END AS lkind,
           (l.sw > 0 OR l.sq > 0) AS alloc,
           CASE WHEN l.sw > 0 THEN round(l.value_mkd * l.cw / l.sw) - round(l.value_mkd * (l.cw - l.w) / l.sw)
                WHEN l.sq > 0 THEN round(l.value_mkd * l.cq / l.sq) - round(l.value_mkd * (l.cq - l.pq) / l.sq)
                ELSE 0::numeric END AS val
    FROM ln2 l
  ) z
),
lp AS MATERIALIZED (       -- one row per sale × product (a product twice on a sale counts once)
  SELECT lv.rid, lv.pkey, lv.source, lv.bucket,
         sum(CASE WHEN lv.bad_qty THEN 0 ELSE lv.qty END) AS units,
         sum(lv.val) AS v,
         max(lv.name) AS any_name,
         bool_or(lv.bad_qty) AS bad_qty
  FROM lv
  WHERE lv.lkind = 'product'
  GROUP BY lv.rid, lv.pkey, lv.source, lv.bucket
),
pa AS MATERIALIZED (
  SELECT q.*,
         row_number() OVER (ORDER BY CASE WHEN (SELECT prm.money FROM prm) THEN q.v ELSE q.units END DESC NULLS LAST,
                                     q.sales DESC, q.pkey) AS rk
  FROM (
    SELECT lp.pkey,
           count(*)                                                                     AS sales,
           sum(lp.units)                                                                AS units,
           sum(lp.v)                                                                    AS v,
           count(*) FILTER (WHERE lp.bucket IN ('paid', 'paid_legacy'))                AS paid,
           count(*) FILTER (WHERE lp.bucket = 'returned')                               AS returned,
           count(*) FILTER (WHERE lp.bucket IN ('courier', 'courier_problem', 'label')) AS courier,
           count(*) FILTER (WHERE lp.bucket = 'to_pack')                                AS to_pack,
           max(lp.any_name)                                                             AS any_name
    FROM lp
    GROUP BY lp.pkey
  ) q
),
-- the top keys as ONE array: a probe per line, never a join over CTE scans
ptop AS MATERIALIZED (
  SELECT coalesce(array_agg(pa.pkey), ARRAY[]::text[]) AS keys
  FROM pa WHERE pa.rk <= (SELECT prm.topn FROM prm)
),
pbs AS MATERIALIZED (      -- per top product × source
  SELECT q.pkey,
         jsonb_agg(jsonb_build_object('key', q.source, 'sales', q.sales, 'units', q.units,
                                      'value_mkd', round(q.v)) ORDER BY s.ord) AS j
  FROM (SELECT lp.pkey, lp.source, count(*) AS sales, sum(lp.units) AS units, sum(lp.v) AS v
          FROM lp
         WHERE lp.pkey = ANY ((SELECT ptop.keys FROM ptop)::text[])
         GROUP BY lp.pkey, lp.source) q
  JOIN srcs s ON s.key = q.source
  GROUP BY q.pkey
),
pj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', t.pkey,
           'name', coalesce((SELECT pr.name FROM public.products pr
                              WHERE t.pkey ~ '^p:[0-9a-f-]{36}$' AND pr.id = substring(t.pkey FROM 3)::uuid), t.any_name),
           'catalogue', t.pkey LIKE 'p:%',
           'sales', t.sales, 'units', t.units, 'value_mkd', round(t.v),
           'paid', t.paid, 'returned', t.returned, 'courier', t.courier, 'to_pack', t.to_pack,
           'by_source', coalesce((SELECT bs.j FROM pbs bs WHERE bs.pkey = t.pkey), '[]'::jsonb))
           ORDER BY t.rk), '[]'::jsonb) AS j
  FROM pa t
  WHERE t.rk <= (SELECT prm.topn FROM prm)
),
po AS (                    -- the rest of the products, one row
  SELECT (SELECT count(*) FROM pa WHERE pa.rk > (SELECT prm.topn FROM prm)) AS products,
         count(DISTINCT lp.rid) AS sales,
         coalesce(sum(lp.units), 0) AS units, coalesce(sum(lp.v), 0) AS v
  FROM lp
  WHERE NOT (lp.pkey = ANY ((SELECT ptop.keys FROM ptop)::text[]))
),
pnp AS (                   -- lines that are not packages: gifts, points, delivery …
  SELECT lv.lkind AS kind, count(*) AS lines, count(DISTINCT lv.rid) AS sales,
         coalesce(sum(lv.qty), 0) AS units, coalesce(sum(lv.val), 0) AS v,
         count(*) FILTER (WHERE NOT lv.by_alias) AS auto
  FROM lv
  WHERE lv.lkind <> 'product'
  GROUP BY lv.lkind
),
pres AS (                  -- sales no line can carry: MEX-only parcels, a sale with no line to spread over
  SELECT count(*) AS sales, coalesce(sum(rt.value_mkd), 0) AS v,
         count(*) FILTER (WHERE rt.kind = 'mex') AS mex_only,
         coalesce(sum(rt.value_mkd) FILTER (WHERE rt.kind = 'mex'), 0) AS mex_v
  FROM rt
  WHERE rt.rid NOT IN (SELECT lv.rid FROM lv WHERE lv.alloc)   -- a hashed sub-plan
),
psum AS (
  SELECT (SELECT count(*) FROM pa)                                          AS products,
         (SELECT count(*) FROM pa WHERE pa.pkey NOT LIKE 'p:%')             AS unmapped_products,
         count(DISTINCT lp.rid)                                             AS sales,
         coalesce(sum(lp.units), 0)                                         AS units,
         coalesce(sum(lp.v), 0)                                             AS v,
         count(DISTINCT lp.rid) FILTER (WHERE lp.pkey NOT LIKE 'p:%')       AS unmapped_sales,
         coalesce(sum(lp.units) FILTER (WHERE lp.pkey NOT LIKE 'p:%'), 0)   AS unmapped_units,
         coalesce(sum(lp.v) FILTER (WHERE lp.pkey NOT LIKE 'p:%'), 0)       AS unmapped_v,
         count(*) FILTER (WHERE lp.bad_qty)                                 AS bad_qty_lines,
         coalesce(sum(lp.v) FILTER (WHERE lp.bad_qty), 0)                   AS bad_qty_v
  FROM lp
),
-- ── cities: mk_city_key once per distinct spelling (Latin, Cyrillic and the
-- MEX "Skopje - Aerodrom" zones fold into one place) ──────────────────────
cr AS MATERIALIZED (       -- per raw spelling first: a hash over ~1.000 rows, not a sort of every sale
  SELECT rt.city_raw AS raw,
         count(*)                                                                     AS n,
         coalesce(sum(rt.value_mkd), 0)                                               AS v,
         count(*) FILTER (WHERE rt.bucket IN ('paid', 'paid_legacy'))                AS paid,
         count(*) FILTER (WHERE rt.bucket = 'returned')                               AS returned,
         count(*) FILTER (WHERE rt.bucket IN ('courier', 'courier_problem', 'label')) AS courier,
         count(*) FILTER (WHERE rt.bucket = 'to_pack')                                AS to_pack
  FROM rt
  GROUP BY rt.city_raw
),
ca AS MATERIALIZED (
  SELECT k.k, sum(cr.n) AS n, sum(cr.v) AS v, sum(cr.paid) AS paid, sum(cr.returned) AS returned,
         sum(cr.courier) AS courier, sum(cr.to_pack) AS to_pack,
         count(cr.raw) AS spellings,
         (array_agg(cr.raw ORDER BY cr.n DESC, cr.raw))[1] AS sample_raw
  FROM cr
  CROSS JOIN LATERAL (SELECT CASE WHEN cr.raw IS NOT NULL THEN public.mk_city_key(cr.raw) END AS k) k
  GROUP BY k.k
),
car AS MATERIALIZED (
  SELECT ca.*, row_number() OVER (ORDER BY ca.n DESC, ca.v DESC, ca.k) AS rk,
         (SELECT jsonb_build_object('name', s.name, 'name_lat', s.name_lat)
            FROM public.mk_settlements s
           WHERE s.name_norm = ca.k
           ORDER BY CASE s.kind WHEN 'city' THEN 1 WHEN 'town' THEN 2 WHEN 'city_district' THEN 3 ELSE 4 END, s.id
           LIMIT 1) AS nm
  FROM ca WHERE ca.k IS NOT NULL
),
cj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', car.k,
           'name', coalesce(car.nm ->> 'name', car.sample_raw),
           'name_lat', coalesce(car.nm ->> 'name_lat', car.sample_raw),
           'known', car.nm IS NOT NULL,
           'count', car.n, 'value_mkd', round(car.v),
           'paid', car.paid, 'returned', car.returned, 'courier', car.courier, 'to_pack', car.to_pack,
           'spellings', car.spellings)
           ORDER BY car.rk), '[]'::jsonb) AS j
  FROM car
  WHERE car.rk <= (SELECT prm.topn FROM prm)
),
csum AS (
  SELECT count(*) FILTER (WHERE car.rk > prm.topn)                        AS others_places,
         coalesce(sum(car.n) FILTER (WHERE car.rk > prm.topn), 0)         AS others_n,
         coalesce(sum(car.v) FILTER (WHERE car.rk > prm.topn), 0)         AS others_v,
         coalesce(sum(car.paid) FILTER (WHERE car.rk > prm.topn), 0)      AS others_paid,
         coalesce(sum(car.returned) FILTER (WHERE car.rk > prm.topn), 0)  AS others_returned,
         coalesce(sum(car.courier) FILTER (WHERE car.rk > prm.topn), 0)   AS others_courier,
         coalesce(sum(car.to_pack) FILTER (WHERE car.rk > prm.topn), 0)   AS others_to_pack,
         count(*)                                                         AS places,
         coalesce(sum(car.spellings), 0)                                  AS spellings,
         count(*) FILTER (WHERE car.nm IS NULL)                           AS unknown_places,
         coalesce(sum(car.n) FILTER (WHERE car.nm IS NULL), 0)            AS unknown_places_n,
         coalesce(sum(car.v) FILTER (WHERE car.nm IS NULL), 0)            AS unknown_places_v
  FROM car CROSS JOIN prm
),
cnull AS (
  SELECT coalesce(max(ca.n), 0) AS n, coalesce(max(ca.v), 0) AS v, coalesce(max(ca.paid), 0) AS paid,
         coalesce(max(ca.returned), 0) AS returned, coalesce(max(ca.courier), 0) AS courier,
         coalesce(max(ca.to_pack), 0) AS to_pack
  FROM ca WHERE ca.k IS NULL
),
-- ── buyers (last-8 phone): new vs returning, repeat within the period ─────
b AS MATERIALIZED (
  SELECT rt.phone8, count(*) AS n, sum(rt.value_mkd) AS v, count(DISTINCT rt.source) AS n_src
  FROM rt WHERE rt.phone8 IS NOT NULL
  GROUP BY rt.phone8
),
-- the shop's classifier once per distinct (status, payment) — as the foundation does
wbo AS MATERIALIZED (
  SELECT d.status, d.payment_status, d.payment_method
  FROM (SELECT DISTINCT w.status, w.payment_status, w.payment_method FROM public.web_orders w) d
  WHERE public.web_order_outcome(d.status, d.payment_status, d.payment_method)
        IN ('delivered', 'no_record', 'returned', 'courier', 'preparing')
),
-- bought before the window: a CRM sale (sale day before `from`), a parcel
-- with money, or a web order the shop counts as a sale. This window's own
-- rows never count (a ledger-dated order, a parcel made before its sale
-- day). Set-based: each history table is read once and hashed against the
-- buyers (hashed sub-plans — no join the planner can mis-size).
bp AS MATERIALIZED (
  SELECT DISTINCT q.p8 AS phone8
  FROM (
    SELECT right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) AS p8
    FROM public.orders x
    WHERE coalesce(x.sold_at, x.confirmed_at, x.created_at) < (SELECT prm.f FROM prm)
      AND x.status IN ('confirmed', 'shipped', 'paid', 'delivered', 'returned')
      AND coalesce(x.price, 0) > 0
      AND x.sale_source_detail IS DISTINCT FROM 'disposition'
      AND x.customer_phone IS NOT NULL
      AND x.id NOT IN (SELECT rt.order_id FROM rt WHERE rt.order_id IS NOT NULL)
    UNION ALL
    SELECT p.phone8
    FROM public.mex_parcels p
    WHERE p.created_at_mex < (SELECT prm.f FROM prm)
      AND coalesce(p.cod_mkd, 0) > 0
      AND p.tracking_id NOT IN (SELECT rt.tracking_id FROM rt WHERE rt.tracking_id IS NOT NULL)
    UNION ALL
    SELECT w.phone8
    FROM public.web_orders w
    WHERE w.created_at < (SELECT prm.f FROM prm)
      AND w.deleted_in_shop_at IS NULL
      AND coalesce(w.total, 0) > 0
      AND (w.status, w.payment_status, w.payment_method) IN (SELECT wbo.status, wbo.payment_status, wbo.payment_method FROM wbo)
  ) q
  WHERE q.p8 IN (SELECT b.phone8 FROM b)
),
bf AS MATERIALIZED (
  SELECT b.*, (b.phone8 IN (SELECT bp.phone8 FROM bp)) AS returning FROM b
),
bj2 AS (
  SELECT jsonb_build_object(
    'buyers',              count(*),
    'returning',           count(*) FILTER (WHERE bf.returning),
    'new',                 count(*) FILTER (WHERE NOT bf.returning),
    'repeat',              count(*) FILTER (WHERE bf.n >= 2),
    'cross_source',        count(*) FILTER (WHERE bf.n_src >= 2),
    'sales',               coalesce(sum(bf.n), 0),
    'sales_new',           coalesce(sum(bf.n) FILTER (WHERE NOT bf.returning), 0),
    'sales_returning',     coalesce(sum(bf.n) FILTER (WHERE bf.returning), 0),
    'value_new_mkd',       round(coalesce(sum(bf.v) FILTER (WHERE NOT bf.returning), 0)),
    'value_returning_mkd', round(coalesce(sum(bf.v) FILTER (WHERE bf.returning), 0)),
    'no_phone',            (SELECT count(*) FROM rt WHERE rt.phone8 IS NULL),
    -- how far back "bought before" can see (CRM orders and MEX parcels)
    'history_from',        to_char(least((SELECT min(x.created_at) FROM public.orders x),
                                         (SELECT min(p.created_at_mex) FROM public.mex_parcels p))
                                   AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD'),
    'by_source', (
      SELECT coalesce(jsonb_agg(jsonb_build_object(
               'key', q.source, 'buyers', q.buyers, 'new', q.nw, 'returning', q.buyers - q.nw, 'repeat', q.rep)
               ORDER BY s.ord), '[]'::jsonb)
      FROM (SELECT y.source, count(*) AS buyers,
                   count(*) FILTER (WHERE y.phone8 NOT IN (SELECT bp.phone8 FROM bp)) AS nw,
                   count(*) FILTER (WHERE y.n >= 2) AS rep
              FROM (SELECT rt.source, rt.phone8, count(*) AS n FROM rt WHERE rt.phone8 IS NOT NULL
                     GROUP BY rt.source, rt.phone8) y
             GROUP BY y.source) q
      JOIN srcs s ON s.key = q.source)) AS j
  FROM bf
),
-- ── basket: packages per sale ────────────────────────────────────────────
-- sales with lines: their package count; sales with none (MEX-only parcels)
-- are the per-source remainder — no join, no lookup
bu AS MATERIALIZED (
  SELECT lv.rid, lv.source, max(lv.value_mkd) AS v,
         coalesce(sum(lv.qty) FILTER (WHERE lv.lkind = 'product' AND NOT lv.bad_qty), 0) AS units
  FROM lv
  GROUP BY lv.rid, lv.source
),
bk AS MATERIALIZED (
  SELECT q.source, q.ub, sum(q.n) AS n, sum(q.v) AS v, sum(q.units) AS units
  FROM (
    SELECT bu.source,
           CASE WHEN bu.units <= 0 THEN 'none' WHEN bu.units >= 5 THEN '5' ELSE bu.units::text END AS ub,
           count(*) AS n, coalesce(sum(bu.v), 0) AS v, coalesce(sum(bu.units), 0) AS units
    FROM bu
    GROUP BY 1, 2
    UNION ALL
    SELECT a.source, 'none', a.n - coalesce(l.n, 0), a.v - coalesce(l.v, 0), 0
    FROM (SELECT rt.source, count(*) AS n, coalesce(sum(rt.value_mkd), 0) AS v FROM rt GROUP BY rt.source) a
    LEFT JOIN (SELECT bu.source, count(*) AS n, coalesce(sum(bu.v), 0) AS v FROM bu GROUP BY bu.source) l
           ON l.source = a.source
  ) q
  GROUP BY q.source, q.ub
),
bkj AS (
  SELECT jsonb_build_object(
    'dist', (SELECT jsonb_agg(jsonb_build_object('key', k.key, 'count', coalesce(z.n, 0), 'value_mkd', round(coalesce(z.v, 0)))
                              ORDER BY k.ord)
               FROM (VALUES ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('none', 6)) k(key, ord)
               LEFT JOIN (SELECT bk.ub, sum(bk.n) AS n, sum(bk.v) AS v FROM bk GROUP BY bk.ub) z ON z.ub = k.key),
    'by_source', (SELECT jsonb_agg(jsonb_build_object(
                           'key', s.key,
                           'count', coalesce(z.n, 0),
                           'with_units', coalesce(z.nu, 0),
                           'units', coalesce(z.units, 0),
                           'value_mkd', round(coalesce(z.v, 0)),
                           'dist', (SELECT jsonb_agg(jsonb_build_object('key', k.key, 'count', coalesce(bk2.n, 0)) ORDER BY k.ord)
                                      FROM (VALUES ('1', 1), ('2', 2), ('3', 3), ('4', 4), ('5', 5), ('none', 6)) k(key, ord)
                                      LEFT JOIN bk bk2 ON bk2.source = s.key AND bk2.ub = k.key))
                           ORDER BY s.ord)
                    FROM srcs s
                    LEFT JOIN (SELECT bk.source, sum(bk.n) AS n, sum(bk.n) FILTER (WHERE bk.ub <> 'none') AS nu,
                                      sum(bk.units) AS units, sum(bk.v) AS v
                                 FROM bk GROUP BY bk.source) z ON z.source = s.key)) AS j
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char(prm.fd, 'YYYY-MM-DD'),
    'to', to_char(prm.td, 'YYYY-MM-DD'),
    'generated_at', now(),
    'money', true,
    'clock', 'sale',
    'part', 'detail',
    'top_n', prm.topn),
  'total', (SELECT jsonb_build_object('count', count(*), 'value_mkd', round(coalesce(sum(rt.value_mkd), 0))) FROM rt),
  'products',  jsonb_build_object(
                 'rows', (SELECT j FROM pj),
                 'others', (SELECT jsonb_build_object('products', po.products, 'sales', po.sales, 'units', po.units,
                                                      'value_mkd', round(po.v)) FROM po),
                 'non_product', (SELECT coalesce(jsonb_agg(jsonb_build_object('kind', pnp.kind, 'lines', pnp.lines,
                                   'sales', pnp.sales, 'units', pnp.units, 'value_mkd', round(pnp.v), 'auto', pnp.auto)
                                   ORDER BY pnp.lines DESC), '[]'::jsonb) FROM pnp),
                 'no_product', (SELECT jsonb_build_object('sales', pres.sales, 'value_mkd', round(pres.v),
                                                          'mex_only', pres.mex_only, 'mex_only_value_mkd', round(pres.mex_v))
                                  FROM pres),
                 'summary', (SELECT jsonb_build_object('products', psum.products, 'units', psum.units,
                                                       'value_mkd', round(psum.v), 'sales', psum.sales,
                                                       'unmapped_products', psum.unmapped_products,
                                                       'unmapped_units', psum.unmapped_units,
                                                       'unmapped_value_mkd', round(psum.unmapped_v),
                                                       'unmapped_sales', psum.unmapped_sales,
                                                       'bad_qty_lines', psum.bad_qty_lines,
                                                       'bad_qty_value_mkd', round(psum.bad_qty_v))
                               FROM psum)),
  'cities',    jsonb_build_object(
                 'rows', (SELECT j FROM cj),
                 'others', (SELECT jsonb_build_object('places', csum.others_places, 'count', csum.others_n,
                                                      'value_mkd', round(csum.others_v), 'paid', csum.others_paid,
                                                      'returned', csum.others_returned, 'courier', csum.others_courier,
                                                      'to_pack', csum.others_to_pack) FROM csum),
                 'unknown', (SELECT jsonb_build_object('count', cnull.n, 'value_mkd', round(cnull.v), 'paid', cnull.paid,
                                                       'returned', cnull.returned, 'courier', cnull.courier,
                                                       'to_pack', cnull.to_pack) FROM cnull),
                 'places', (SELECT csum.places FROM csum),
                 'spellings', (SELECT csum.spellings FROM csum),
                 'unknown_places', (SELECT csum.unknown_places FROM csum),
                 'unknown_places_count', (SELECT csum.unknown_places_n FROM csum),
                 'unknown_places_value_mkd', (SELECT round(csum.unknown_places_v) FROM csum)),
  'customers', (SELECT j FROM bj2),
  'basket',    (SELECT j FROM bkj))
FROM prm
$detail$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  ELSE
    EXECUTE $summary$
WITH
srcs AS (
  SELECT * FROM (VALUES ('altercpa', 1), ('elyon_crm', 2), ('teleshop_out', 3), ('teleshop_other', 4),
                        ('social', 5), ('web', 6)) v(key, ord)
),
bks AS (
  SELECT * FROM (VALUES ('paid', 1), ('paid_unproven', 2), ('paid_legacy', 3), ('courier', 4),
                        ('courier_problem', 5), ('label', 6), ('to_pack', 7), ('returned', 8)) v(key, ord)
),
r AS MATERIALIZED (
  SELECT s.source, s.bucket, s.value_mkd, s.cod_mkd
  FROM public.insights_sale_rows($1, $2, false) s
  WHERE s.in_total
),
ag AS (
  SELECT coalesce(r.source, '*') AS src, r.bucket, count(*) AS n,
         coalesce(sum(r.value_mkd), 0) AS v, coalesce(sum(r.cod_mkd), 0) AS c
  FROM r
  GROUP BY GROUPING SETS ((r.source, r.bucket), (r.bucket))
),
tot AS (
  SELECT sc.src,
         jsonb_build_object('count', coalesce(sum(a.n), 0), 'value_mkd', round(coalesce(sum(a.v), 0)),
                            'cod_mkd', round(coalesce(sum(a.c), 0))) AS j
  FROM (SELECT '*'::text AS src UNION ALL SELECT s.key FROM srcs s) sc
  LEFT JOIN ag a ON a.src = sc.src
  GROUP BY sc.src
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object(
    'from', to_char($3::date, 'YYYY-MM-DD'),
    'to', to_char($4::date, 'YYYY-MM-DD'),
    'money', true,
    'clock', 'sale',
    'part', 'summary'),
  'total', (SELECT t.j FROM tot t WHERE t.src = '*'),
  'buckets', (SELECT jsonb_agg(jsonb_build_object('key', b.key, 'count', coalesce(a.n, 0),
                                                  'value_mkd', round(coalesce(a.v, 0)), 'cod_mkd', round(coalesce(a.c, 0)))
                               ORDER BY b.ord)
                FROM bks b LEFT JOIN ag a ON a.src = '*' AND a.bucket = b.key),
  'by_source', (SELECT jsonb_agg(jsonb_build_object('key', s.key, 'total', t.j) ORDER BY s.ord)
                  FROM srcs s JOIN tot t ON t.src = s.key))
$summary$
    INTO v_out
    USING p_from, p_to_end, v_fd, v_td, v_gran, v_top, coalesce(p_money, false);
  END IF;

  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(v_out);
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$function$;

-- public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean)
CREATE OR REPLACE FUNCTION public.insights_profit(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'cohort'::text, p_granularity text DEFAULT NULL::text, p_detail boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- $1 from · $2 to_end · $3 granularity ('day' | 'month') · $4 detail
  v_head_cohort text := $hc$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE sale cohort (insights_sale_rows), each sale's group:
--   collected = paid (MEX delivered) + paid_legacy · returned · open (courier,
--   problem, label, to pack) · unproven (CRM paid, no parcel — never profit)
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.card_mkd, r.sale_day,
         r.order_id, r.web_id, r.tracking_id, r.q_shared_parcel,
         CASE WHEN r.bucket IN ('paid', 'paid_legacy') THEN 'collected'
              WHEN r.bucket = 'returned'               THEN 'returned'
              WHEN r.bucket = 'paid_unproven'          THEN 'unproven'
              WHEN r.in_total                          THEN 'open' END AS g
  FROM public.insights_sale_rows($1, $2, false) r
),
-- a parcel two orders share (owner-ruled accurate) is ONE parcel to MEX: each
-- holder carries 1/holders of it — counted over ALL its holders (the
-- foundation's rule: real, non-test orders), not only those in the window,
-- so any split of a window into pieces adds up to the same parcels
shp AS (
  SELECT x.mex_tracking_id AS tracking_id, count(*) AS c
  FROM public.orders x
  WHERE x.mex_tracking_id IN (SELECT sr.tracking_id FROM sr WHERE sr.q_shared_parcel AND sr.tracking_id IS NOT NULL)
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), (SELECT public.report_excluded_phone8s()))
  GROUP BY 1
),
s0 AS (
  SELECT sr.g, sr.source, sr.kind,
         coalesce(sr.value_mkd, 0)::float8 AS rev, coalesce(sr.card_mkd, 0)::float8 AS card,
         sr.sale_day AS day, sr.order_id, sr.web_id, sr.tracking_id,
         CASE WHEN shp.c > 1 THEN 1.0::float8 / shp.c ELSE 1.0::float8 END AS pw
  FROM sr LEFT JOIN shp ON shp.tracking_id = sr.tracking_id AND sr.q_shared_parcel
  WHERE sr.g IS NOT NULL
),
$hc$;
  v_head_cash text := $hh$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE cash flow (insights_cash_rows): every MEX parcel delivered in the
-- window, once, with its owner; revenue = COD + the card money of a
-- card-paid web order
s0 AS (
  SELECT 'collected'::text AS g, c.source, c.kind,
         (coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))::float8 AS rev,
         coalesce(c.card_mkd, 0)::float8 AS card,
         (c.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS day,
         c.order_id, c.web_id, c.tracking_id, 1.0::float8 AS pw
  FROM public.insights_cash_rows($1, $2) c
),
$hh$;
  v_common text := $cm$
s1 AS MATERIALIZED (
  SELECT row_number() OVER () AS sid, s0.*,
         to_char(date_trunc(prm.gran, s0.day::timestamp), prm.fmt) AS d
  FROM s0 CROSS JOIN prm
),
oid AS MATERIALIZED (SELECT DISTINCT s1.order_id AS id FROM s1 WHERE s1.order_id IS NOT NULL),
oi AS MATERIALIZED (
  SELECT i.order_id, i.product_id, i.product_name,
         coalesce(i.quantity, 0) AS qty,
         coalesce(i.price_per_unit, 0)::float8 AS ppu,
         coalesce(i.total_price, 0)::float8 AS tp
  FROM public.order_items i JOIN oid ON oid.id = i.order_id
),
oia AS (
  SELECT oi.order_id,
         sum((CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty) AS bonus_items
  FROM oi GROUP BY 1
),
-- index.ts orderPackageBonus(), unchanged: EUR per package by the line's
-- unit price (<25 → 1 · 25–35 → 2 · ≥35 → 3), only when status = 'paid';
-- an order with no lines prices its own quantity. The owner (ownerOf()
-- before normAgent) goes out raw: the api applies the agents-only gate.
ob AS MATERIALIZED (
  SELECT x.id, x.status::text AS status, x.sale_source, x.product_id, x.product_name,
         coalesce(x.confirmed_by_name, x.assigned_agent_name) AS owner_raw,
         nullif(btrim(x.cpa_webmaster_id), '') AS wm,
         (a.order_id IS NOT NULL) AS has_items,
         CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END AS oq,
         CASE WHEN x.status::text <> 'paid' THEN 0
              WHEN a.order_id IS NOT NULL THEN coalesce(a.bonus_items, 0)
              ELSE (CASE WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 > 25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)
         END::float8 AS bonus_eur
  FROM public.orders x
  JOIN oid ON oid.id = x.id
  LEFT JOIN oia a ON a.order_id = x.id
),
s AS MATERIALIZED (
  SELECT s1.*, ob.owner_raw, ob.status AS crm_status,
         CASE WHEN s1.source = 'altercpa' THEN coalesce(ob.wm, '__none__') END AS wm,
         coalesce(ob.bonus_eur, 0) AS bonus_eur
  FROM s1 LEFT JOIN ob ON ob.id = s1.order_id
),
-- every P&L sale's lines (collected + returned); a sale with none gets one
-- pseudo line so its revenue is never dropped
ln0 AS MATERIALIZED (
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_name AS name, oi.product_id AS pid, oi.qty,
         CASE WHEN oi.ppu > 0 THEN oi.ppu * greatest(oi.qty, 0) WHEN oi.tp > 0 THEN oi.tp ELSE 0 END::float8 AS w0,
         CASE WHEN ob.status = 'paid'
              THEN (CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty ELSE 0 END::float8 AS lb,
         NULL::text AS wkind
  FROM s JOIN ob ON ob.id = s.order_id JOIN oi ON oi.order_id = s.order_id
  WHERE s.g IN ('collected', 'returned')
  UNION ALL
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
         ob.product_name, ob.product_id, ob.oq, 1::float8, ob.bonus_eur, NULL
  FROM s JOIN ob ON ob.id = s.order_id
  WHERE s.g IN ('collected', 'returned') AND NOT ob.has_items
  UNION ALL
  -- web_order_items joined straight (its index), never through a CTE: the
  -- planner cannot size a CTE and loops over it once per web sale
  SELECT s.sid, 'web', wi.name, NULL::uuid, coalesce(wi.quantity, 0),
         CASE WHEN wi.kind = 'GIFT' THEN 0
              ELSE greatest(coalesce(wi.price, 0) * coalesce(wi.quantity, 0) - coalesce(wi.discount_allocated, 0), 0) END::float8,
         0::float8, wi.kind
  FROM s JOIN public.web_order_items wi ON wi.shop_order_id = s.web_id
  WHERE s.g IN ('collected', 'returned') AND s.kind = 'web'
  UNION ALL
  SELECT s.sid, CASE WHEN s.kind = 'mex' THEN 'mex' ELSE 'none' END, NULL, NULL, 0, 1::float8, 0::float8, NULL
  FROM s
  WHERE s.g IN ('collected', 'returned')
    AND (s.kind = 'mex'
         OR (s.kind = 'web' AND NOT EXISTS (SELECT 1 FROM public.web_order_items wi WHERE wi.shop_order_id = s.web_id)))
),
-- the catalogue by its folded name (product_alias_norm): an exact name match
-- (case / spaces ignored) IS that catalogue product; spelling variants still
-- wait for reviewed product_aliases rows
cat AS (
  SELECT DISTINCT ON (public.product_alias_norm(p.name))
         public.product_alias_norm(p.name) AS nn, p.id
  FROM public.products p
  WHERE public.product_alias_norm(p.name) IS NOT NULL
  ORDER BY public.product_alias_norm(p.name), (coalesce(p.cost_price, 0) > 0) DESC, p.is_active DESC, p.created_at, p.id
),
-- keys and kinds once per distinct line (product_key() is not inlinable)
lk AS MATERIALIZED (
  SELECT d.src, d.pk_name, d.pk_pid, k.key0, k.nn, k.rk
  FROM (SELECT DISTINCT ln0.src, ln0.name, ln0.pid,
               coalesce(ln0.name, '') AS pk_name, coalesce(ln0.pid::text, '') AS pk_pid
          FROM ln0 WHERE ln0.src IN ('crm', 'collabbox', 'web')) d
  CROSS JOIN LATERAL (
    SELECT public.product_key(d.src, d.name, d.pid) AS key0,
           public.product_alias_norm(d.name) AS nn,
           (SELECT a.kind FROM public.product_aliases a
             WHERE a.source IN (d.src, 'any') AND a.alias_norm = public.product_alias_norm(d.name)
             ORDER BY (a.source = d.src) DESC LIMIT 1) AS rk
  ) k
),
lk2 AS MATERIALIZED (
  SELECT lk.src, lk.pk_name, lk.pk_pid,
         CASE WHEN lk.key0 LIKE 'p:%' THEN lk.key0
              WHEN cat.id IS NOT NULL THEN 'p:' || cat.id::text
              ELSE coalesce(lk.key0, '__unknown__') END AS k,
         -- a reviewed alias decides; until then the obvious non-product lines
         -- of the collabBox / CRM imports are recognised by their name
         coalesce(lk.rk,
           CASE WHEN lk.nn ~ '^(поен|poen)'          THEN 'loyalty_point'
                WHEN lk.nn ~ '^(достав|dostav)'      THEN 'delivery'
                WHEN lk.nn ~ '^(забелешк|zabeles)'   THEN 'note'
                WHEN lk.nn ~ '^(флаер|flaer|flyer)'  THEN 'flyer' END) AS kind0,
         (lk.rk IS NOT NULL) AS reviewed
  FROM lk LEFT JOIN cat ON cat.nn = lk.nn AND lk.key0 NOT LIKE 'p:%'
),
-- a known cost is a catalogue cost_price > 0 (EUR) — never invented
kc AS (
  SELECT DISTINCT ON (k2.k) k2.k, CASE WHEN p.cost_price > 0 THEN p.cost_price::numeric END AS cost_eur, p.name AS pname
  FROM lk2 k2 JOIN public.products p ON k2.k = 'p:' || p.id::text
  ORDER BY k2.k
),
ln1 AS (
  SELECT ln0.sid, ln0.name, ln0.qty, ln0.w0, ln0.lb,
         CASE WHEN ln0.src = 'mex' THEN '__mex_only__' WHEN ln0.src = 'none' THEN '__unknown__'
              ELSE coalesce(k2.k, '__unknown__') END AS k,
         CASE WHEN ln0.src IN ('mex', 'none') THEN 'unknown'
              ELSE coalesce(k2.kind0, CASE WHEN ln0.wkind = 'GIFT' THEN 'gift' END, 'product') END AS kind,
         coalesce(k2.reviewed, false) AS reviewed,
         kc.cost_eur::float8 AS cost_eur, kc.pname
  FROM ln0
  LEFT JOIN lk2 k2 ON k2.src = ln0.src AND k2.pk_name = coalesce(ln0.name, '') AND k2.pk_pid = coalesce(ln0.pid::text, '')
  LEFT JOIN kc ON kc.k = k2.k
),
-- per sale: the weights its value is split by
ls AS (
  SELECT ln1.sid, sum(ln1.w0) AS sw,
         sum(CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty ELSE 0 END) AS sq,
         count(*) AS nl,
         count(*) FILTER (WHERE ln1.kind IN ('product', 'gift')) AS np
  FROM ln1 GROUP BY 1
),
ln AS (
  SELECT ln1.sid, ln1.k, ln1.kind, ln1.reviewed, (ln1.kind IN ('product', 'gift')) AS pkg,
         ln1.qty, ln1.lb, ln1.cost_eur,
         coalesce(ln1.pname, ln1.name) AS name,
         s.g, s.source, s.d, s.wm,
         -- the sale's value by price weight; all-zero prices → by packages
         s.rev * (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
                       WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
                       ELSE 1.0::float8 / ls.nl END) AS rv,
         -- the sale's parcel by packages (courier share)
         s.pw * (CASE WHEN ls.np = 0 THEN 1.0::float8 / ls.nl
                      WHEN ln1.kind NOT IN ('product', 'gift') THEN 0
                      WHEN ls.sq > 0 THEN ln1.qty::float8 / ls.sq
                      ELSE 1.0::float8 / ls.np END) AS sh,
         (ln1.kind IN ('product', 'gift') AND ls.sw > 0 AND ln1.w0 = 0) AS free
  FROM ln1 JOIN ls ON ls.sid = ln1.sid JOIN s ON s.sid = ln1.sid
),
lm AS MATERIALIZED (     -- line measures (денари; cost EUR × 61,5)
  SELECT ln.*,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.rv ELSE 0 END AS rc,
         CASE WHEN (ln.pkg AND ln.cost_eur IS NULL) OR ln.kind = 'unknown' THEN ln.rv ELSE 0 END AS ru,
         CASE WHEN NOT ln.pkg AND ln.kind <> 'unknown' THEN ln.rv ELSE 0 END AS rn,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.cost_eur * ln.qty * 61.5 ELSE 0 END AS cm,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.qty ELSE 0 END AS pc,
         CASE WHEN ln.pkg AND ln.cost_eur IS NULL THEN ln.qty ELSE 0 END AS pu,
         CASE WHEN ln.free THEN ln.qty ELSE 0 END AS fr
  FROM ln
),
agg_s AS (    -- sale-level measures
  SELECT s.g, s.source, s.d, s.wm, count(*) AS n, sum(s.rev) AS rev, sum(s.card) AS card, sum(s.pw) AS pw
  FROM s GROUP BY GROUPING SETS ((s.g, s.source), (s.g, s.d), (s.g, s.wm))
),
agg_l AS (    -- line measures on the same grains
  SELECT lm.g, lm.source, lm.d, lm.wm,
         sum(lm.rc) AS rc, sum(lm.ru) AS ru, sum(lm.rn) AS rn, sum(lm.cm) AS cm,
         sum(lm.pc) AS pc, sum(lm.pu) AS pu, sum(lm.fr) AS fr, sum(lm.lb) AS lb
  FROM lm GROUP BY GROUPING SETS ((lm.g, lm.source), (lm.g, lm.d), (lm.g, lm.wm))
),
agg AS (
  SELECT a.g,
         CASE WHEN a.source IS NOT NULL THEN 's' WHEN a.d IS NOT NULL THEN 'd' ELSE 'w' END AS dim,
         coalesce(a.source, a.d, a.wm) AS key,
         -- 9 decimals: a month-by-month cache adds up to the whole window exactly once rounded to denars
         a.n, round(a.rev::numeric, 9) AS rev, round(a.card::numeric, 9) AS card, round(a.pw::numeric, 9) AS pw,
         round(coalesce(l.rc, 0)::numeric, 9) AS rc, round(coalesce(l.ru, 0)::numeric, 9) AS ru, round(coalesce(l.rn, 0)::numeric, 9) AS rn,
         round(coalesce(l.cm, 0)::numeric, 9) AS cm, coalesce(l.pc, 0) AS pc, coalesce(l.pu, 0) AS pu,
         coalesce(l.fr, 0) AS fr, coalesce(l.lb, 0)::numeric AS lb
  FROM agg_s a
  LEFT JOIN agg_l l ON l.g = a.g
       AND coalesce(l.source, '') = coalesce(a.source, '') AND coalesce(l.d, '') = coalesce(a.d, '')
       AND coalesce(l.wm, '') = coalesce(a.wm, '')
  WHERE a.source IS NOT NULL OR a.d IS NOT NULL OR a.wm IS NOT NULL
),
comm AS (     -- today's per-package bonus of every paid order, at owner grain
  SELECT s.source, s.d, s.wm, s.owner_raw, sum(s.bonus_eur)::numeric AS b, count(*) AS n
  FROM s WHERE s.g = 'collected' AND s.bonus_eur > 0
  GROUP BY GROUPING SETS ((s.source, s.owner_raw), (s.d, s.owner_raw), (s.wm, s.owner_raw))
),
wmn AS (
  SELECT DISTINCT ON (w.wm_id) w.wm_id, w.name
  FROM public.altercpa_webmasters w
  WHERE nullif(btrim(w.name), '') IS NOT NULL
  ORDER BY w.wm_id, w.named_at DESC NULLS LAST, w.updated_at DESC
),
$cm$;
  v_tail_cohort text := $tc$
cb AS (       -- the cohort strip: Σ = insights_cohort, bucket by bucket
  SELECT sr.source AS s, sr.bucket AS b, count(*) AS n,
         round(coalesce(sum(sr.value_mkd), 0)) AS v,
         round(coalesce(sum(sr.cod_mkd), 0))   AS c,
         count(*) FILTER (WHERE sr.kind = 'order') AS no,
         count(*) FILTER (WHERE sr.kind = 'web')   AS nw,
         count(*) FILTER (WHERE sr.kind = 'mex')   AS nm,
         count(*) FILTER (WHERE sr.kind = 'booking') AS nb
  FROM sr GROUP BY 1, 2
),
pn AS (       -- how many sales carry the product (a narrow hash, no DISTINCT sort)
  SELECT x.source, x.g, x.k, count(*) AS n
  FROM (SELECT lm.source, lm.g, lm.k, lm.sid FROM lm GROUP BY 1, 2, 3, 4) x
  GROUP BY 1, 2, 3
),
prod AS (     -- the product P&L (collected and returned), by source
  SELECT lm.source AS s, lm.g, lm.k,
         -- byte order (COLLATE "C"): the api folds pieces with the same rule
         min(lm.name COLLATE "C") AS name, min(lm.kind COLLATE "C") AS kind, bool_or(lm.reviewed) AS reviewed,
         bool_or(lm.pkg) AS pkg, max(lm.cost_eur) AS cost_eur, max(pn.n) AS n,
         sum(lm.qty) AS qty, sum(CASE WHEN lm.pkg THEN lm.qty ELSE 0 END) AS pkgs, sum(lm.fr) AS fr,
         round(sum(lm.rv)::numeric, 9) AS rev, round(sum(lm.cm)::numeric, 9) AS cm,
         round(sum(lm.sh)::numeric, 9) AS sh, sum(lm.lb)::numeric AS lb
  FROM lm JOIN pn ON pn.source = lm.source AND pn.g = lm.g AND pn.k = lm.k
  GROUP BY 1, 2, 3
),
pd AS (       -- realized денари per paid package (collected, real products), binned to the denar
  SELECT lm.source AS s, round(lm.rv / lm.qty)::int AS u, sum(lm.qty) AS q, sum(lm.rv) AS v
  FROM lm
  WHERE lm.g = 'collected' AND lm.pkg AND NOT lm.free AND lm.qty > 0 AND lm.rv > 0
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'clock', 'cohort',
  'granularity', (SELECT gran FROM prm),
  'strip', coalesce((SELECT jsonb_agg(to_jsonb(cb) ORDER BY cb.s, cb.b) FROM cb), '[]'::jsonb),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'products', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(to_jsonb(prod) ORDER BY prod.rev DESC, prod.k) FROM prod), '[]'::jsonb) END,
  'hist', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(jsonb_build_object('s', pd.s, 'u', pd.u, 'q', pd.q, 'v', round(pd.v::numeric, 9))) FROM pd), '[]'::jsonb) END,
  'no_items', (SELECT jsonb_build_object('n', count(*), 'v', round(coalesce(sum(s.rev), 0)))
                 FROM s JOIN ob ON ob.id = s.order_id
                WHERE s.g = 'collected' AND NOT ob.has_items)
)
$tc$;
  v_tail_cash text := $th$
xp AS MATERIALIZED (SELECT public.report_excluded_phone8s() AS l),
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
rp AS (       -- parcels MEX returned in the window, owned as a sale is (web claim → order → MEX-only)
  SELECT p.tracking_id,
         to_char(date_trunc(prm.gran, (p.returned_at AT TIME ZONE 'Europe/Skopje')::date::timestamp), prm.fmt) AS d,
         CASE WHEN EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id) THEN 'web'
              ELSE coalesce(
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE x.mex_tracking_id = p.tracking_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                  ORDER BY x.created_at, x.id LIMIT 1),
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE p.order_id IS NOT NULL AND x.id = p.order_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'),
                public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference))) END AS source
  FROM public.mex_parcels p CROSS JOIN prm CROSS JOIN xp
  WHERE p.returned_at BETWEEN prm.f AND prm.t
    AND NOT public.insights_excluded8(p.phone8, xp.l)
)
SELECT jsonb_build_object(
  'clock', 'cash',
  'granularity', (SELECT gran FROM prm),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'returned_parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('s', r.source, 'd', r.d, 'n', r.n))
           FROM (SELECT rp.source, rp.d, count(*) AS n FROM rp GROUP BY 1, 2) r), '[]'::jsonb)
)
$th$;
  v_gran text;
  v_days integer;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_profit: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'cohort') NOT IN ('cohort', 'cash') THEN
    RAISE EXCEPTION 'insights_profit: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- daily up to 62 Skopje days, monthly beyond (as insights_cohort's spark);
  -- a caller that splits a window passes the whole window's granularity
  v_days := (p_to_end AT TIME ZONE 'Europe/Skopje')::date - (p_from AT TIME ZONE 'Europe/Skopje')::date + 1;
  v_gran := CASE WHEN p_granularity IN ('day', 'month') THEN p_granularity
                 WHEN v_days <= 62 THEN 'day' ELSE 'month' END;

  IF coalesce(p_clock, 'cohort') = 'cohort' THEN
    EXECUTE v_head_cohort || v_common || v_tail_cohort INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  ELSE
    EXECUTE v_head_cash || v_common || v_tail_cash INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  END IF;
  RETURN v_out;
END;
$function$;

-- public.insights_returns(timestamp with time zone,timestamp with time zone,text,timestamp with time zone,timestamp with time zone,text[],boolean)
CREATE OR REPLACE FUNCTION public.insights_returns(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'sale'::text, p_prev_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_prev_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone, p_sources text[] DEFAULT NULL::text[], p_money boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
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
    SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) AS source,
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
    count(*) FILTER (WHERE r.cur AND r.in_total AND r.kind = 'booking')          AS base_b,
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
         count(*) FILTER (WHERE cx.kind = 'booking')                     AS bb,
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
           'base_orders', s.bo, 'base_web', s.bw, 'base_mex_only', s.bm, 'base_booked', s.bb,
           'orders', s.ro, 'web', s.rw, 'mex_only', s.rm,
           'splits', coalesce((
             SELECT jsonb_agg(jsonb_build_object(
                      'key', x.split, 'kind', x.kind, 'base', x.base, 'returned', x.ret,
                      'value_mkd', round(x.ret_v),
                      'rate', CASE WHEN x.base > 0 THEN round(x.ret::numeric / x.base, 4) END)
                    ORDER BY x.base DESC, x.split)
             FROM ga x WHERE x.dim = 'split' AND x.source = s.source), '[]'::jsonb))
         ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'], s.source)), '[]'::jsonb) AS j
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
                               'orders', kp.base_o, 'web', kp.base_w, 'mex_only', kp.base_m, 'booked', kp.base_b),
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
$function$;

-- public.insights_people(timestamp with time zone,timestamp with time zone,timestamp with time zone,timestamp with time zone,uuid)
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
-- or Телешоп – Lead out (teleshop_out, 20260942001000) → 'teleshop', a
-- social-media sale → 'social', anything else → 'none'. k: s sale · w decision · p presence day · r roster.
ev AS MATERIALIZED (
  SELECT 's'::text AS k, s.person_id,
         coalesce(m.team_key, CASE s.source WHEN 'teleshop_other' THEN 'teleshop' WHEN 'teleshop_out' THEN 'teleshop'
                                            WHEN 'social' THEN 'social' ELSE 'none' END) AS grp,
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
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, m.role
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
tj AS (
  SELECT coalesce(jsonb_agg(x.j ORDER BY x.ord, x.key), '[]'::jsonb) AS j
  FROM (
    SELECT g.grp AS key,
           CASE g.grp WHEN 'altercpa_leads' THEN 1 WHEN 'crm_prediction' THEN 2 WHEN 'teleshop' THEN 3
                      WHEN 'social' THEN 4 WHEN 'management' THEN 5 WHEN 'none' THEN 9 ELSE 6 END AS ord,
           g.m || jsonb_build_object(
             'key',   g.grp,
             'name',  st.name,
             'mode',  st.leaderboard_mode,
             'kind',  CASE WHEN g.grp IN ('teleshop', 'social', 'none') THEN g.grp ELSE 'team' END,
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
             'members', coalesce((SELECT jsonb_agg(x.m || jsonb_build_object('person_id', x.person_id)
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
         CASE WHEN np.sold_by_ext IS NOT NULL THEN 'unmapped'
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
                       'role', m.role, 'primary', m.is_primary) ORDER BY m.valid_from DESC), '[]'::jsonb)
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

-- public.insights_work_credited(timestamp with time zone,timestamp with time zone,uuid)
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
    SELECT r.person_id, r.kind, r.sale_day
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
                             THEN (SELECT count(*) FROM r WHERE r.kind IN ('order', 'booking') AND r.person_id IS NULL) END,
           'rows',      (SELECT coalesce(jsonb_agg(jsonb_build_object('p', x.person_id, 'b', to_char(x.b, 'YYYY-MM-DD'), 'n', x.n)
                                                   ORDER BY x.person_id, x.b), '[]'::jsonb) FROM x))
    INTO v_out;

  RETURN v_out;
END;
$function$;

-- public.leaderboard_day_v2(date,text,text)
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
  v_from  timestamptz;
  v_to    timestamptz;
  v_out   jsonb;
BEGIN
  IF v_dept IS NOT NULL
     AND v_dept NOT IN ('altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web') THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown department %', v_dept USING ERRCODE = '22023';
  END IF;
  IF v_team IS NOT NULL AND v_team <> 'none'
     AND NOT EXISTS (SELECT 1 FROM public.sales_teams t WHERE t.key = v_team) THEN
    RAISE EXCEPTION 'leaderboard_day_v2: unknown team %', v_team USING ERRCODE = '22023';
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
  WHERE b.doc_at BETWEEN $1::timestamptz AND $2::timestamptz
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
         sum(x.worked) AS worked, sum(x.sale_d) AS sale_d
  FROM (
    SELECT so.pid AS person_id, so.dept,
           CASE WHEN so.in_total THEN 1 ELSE 0 END AS sales,
           CASE WHEN so.in_total THEN so.value_mkd ELSE 0 END AS value_mkd,
           CASE WHEN so.in_total AND so.bucket = 'returned' THEN 1 ELSE 0 END AS returned,
           CASE WHEN so.in_total THEN 0 ELSE 1 END AS cas,
           CASE WHEN so.in_total THEN 0 ELSE so.value_mkd END AS cas_mkd,
           CASE WHEN so.in_total AND so.unstamped THEN 1 ELSE 0 END AS live,
           0 AS booked, 0 AS booked_mkd, 0 AS twin, 0 AS twin_mkd, 0 AS worked, 0 AS sale_d
      FROM so WHERE so.pid IS NOT NULL
    UNION ALL
    SELECT bkc.person_id, bkc.dept, 0, 0, 0, 0, 0, 0,
           bkc.booked, bkc.booked_mkd, bkc.twin, bkc.twin_mkd, 0, 0
      FROM bkc WHERE bkc.person_id IS NOT NULL
    UNION ALL
    SELECT vw.person_id, vw.dept, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
           1, CASE WHEN vw.outcome = 'sale' THEN 1 ELSE 0 END
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
         sum(pd.worked) AS worked,
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
  SELECT DISTINCT ON (m.person_id) m.person_id, m.team_key, st.name AS team_name
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
         pt.team_key, pt.team_name,
         EXISTS (SELECT 1 FROM mem WHERE mem.person_id = p.person_id) AS is_member,
         (coalesce(sp.is_manager, false)
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
         coalesce(wk.worked, 0) AS worked, coalesce(wk.sale_d, 0) AS sale_d,
         coalesce(wk.cancel_d, 0) AS cancel_d, coalesce(wk.trash_d, 0) AS trash_d,
         coalesce(wk.callback_d, 0) AS callback_d, wk.last_at,
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
rf AS (
  SELECT r0.* FROM r0
  WHERE ($4::text IS NULL OR r0.f_any)
    AND ($5::text IS NULL OR coalesce(r0.team_key, 'none') = $5::text)
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
  -- the teams on the (department-filtered) board, for the filter bar
  'teams', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', t.k, 'name', t.nm, 'people', t.n)
                                      ORDER BY t.ord, t.k), '[]'::jsonb)
              FROM (SELECT coalesce(r0.team_key, 'none') AS k, max(r0.team_name) AS nm, count(*) AS n,
                           min(CASE coalesce(r0.team_key, 'none') WHEN 'altercpa_leads' THEN 1
                                    WHEN 'crm_prediction' THEN 2 WHEN 'management' THEN 8
                                    WHEN 'none' THEN 9 ELSE 5 END) AS ord
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

COMMIT;
