-- ============================================================================
-- The phoneless collabBox twin: compare with the BOOKING, and by name (owner 01.10.2026)
--
-- Apply AFTER 20260944000600 / 0610 / 0620 (collabbox_sale_at, the booking-day readers).
--
-- Teleshop agents confirm a prediction-list sale in the CRM (sold_via 'crm', Affiliate – Lead out)
-- and book it again in collabBox as 10114 LEADS-OUT (or 10050) to ship it. insights_sale_rows
-- skips a booking that is the twin of the customer's CRM / AlterCPA sale — by PHONE. A document
-- WITHOUT a phone (a komitent new in collabBox: no card, not in the teleshop registry) had one
-- guard: the author's own CRM sale within ±10 min of the document's doc_at. doc_at is the DISPATCH
-- day, so a copy booked for a later dispatch never matched, and an agent who keyed the CRM 15–20
-- minutes after the booking was never matched either. 01.10.2026 ~19:45, counted twice under
-- Affiliate – Lead out (17.000 ден): 002-9103-177659/2026 (ORD-361905, dispatch 05.10),
-- 177669 (ORD-362033, 15 min apart), 177645 (ORD-362090, booked 30.09 17:00, CRM 01.10 15:14),
-- 177672 (ORD-362074, 21 min apart; the CRM name field holds a note).
--
--   collabbox_name_key(text)  NEW. A name folded for comparison: words → mk_geo_norm (Cyrillic →
--                        Latin, digraphs, accents), digits / punctuation split words, one-letter
--                        words dropped, distinct, sorted; NULL below two words.
--                        "Никола Николовски" = "Nikola Nikolovski"; "Љубинка Ѓошева" = "Ljubinka
--                        Gjosheva"; "НИКОЛА" → NULL.
--   insights_sale_rows   bk's phoneless branch: the author's own priced CRM sale (same filters as
--                        before) created from 1 day before to 2 days after the booking's SALE time
--                        (collabbox_sale_at — the writer's twin window) AND either within ±10 min
--                        of it, or the customer's name matches after the fold (the CRM sale's own
--                        name, or any name the CRM holds on that sale's phone — 177672's CRM name
--                        is a note, the customer's earlier orders carry "Љубинка Ѓошева"). bk0
--                        carries the komitent's name_key. The phone branch is unchanged.
--                        False positive avoided: 177664 (Мишов Андон, a real sale) vs Маја's
--                        ORD-361954 (Verce Petrevska, 17 min earlier, same price) — the names differ
--                        and it is outside ±10 min.
--   collabbox_apply_one  the twin window (and the near_crm_sale_price_differs flag's ±3 days)
--                        around _sale_at instead of _doc_at — a copy dated days ahead is recognised
--                        as a twin when its parcel appears (same window sizes; the writer never
--                        created an order for a phoneless document — no phone → no_phone).
-- leaderboard_day_v2 / collabbox_booked_today hold no twin rule: the board reads the cohort (sr)
-- and shows every other booking of collabbox_booked_today's filter as booked_twin, so the 10
-- documents move from "booked" to "booked_twin" by themselves; checks.bookings_filter_drift is
-- unchanged (0).
--
-- Read-only impact, 01.10.2026 ~20:00 (every booking still waiting, 14 days): 10 bookings stop
-- counting — 01.10: 177659 · 177669 · 177672 · 002-9102-178166 (ORD-362227, booked 1 min after
-- the CRM sale, dispatch 09.10); 30.09: 177645 · 177653; 29.09: 177627; 28.09: 177574 · 177590;
-- 24.09: 177181 — every one the same author, the same price, a CRM sale ≤ 5 min from the booking
-- or the same customer's name. Unchanged: 177664 and every other booking.
--
-- Every body is the LIVE one (pg_get_functiondef, 01.10.2026) with counted, exact edits; the drift
-- guard refuses if any changed. Signatures, owners and grants are unchanged (CREATE OR REPLACE
-- keeps the ACL). Check: node scripts/verify-booking-day.mjs · verify-insights-ties ·
-- verify-leaderboard-v2 (bookings_filter_drift = 0). Revert: re-apply the previous bodies (git:
-- 20260944000600 for insights_sale_rows, 20260944000500 for collabbox_apply_one).
-- ============================================================================

SET lock_timeout = '10s';

BEGIN;

DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)', 'e7406338692acb5caa2e165d404ccc0c', '96ef7362b8a4213258bd6f8b7305f0ef'),
    ('public.collabbox_apply_one(uuid,jsonb,boolean)', '199afc20f05b9f5ce023a7778c664323', 'd673d2e259d1ffd877f81d06f5a5de78')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'phoneless twin: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
  -- the new helper: absent, or this migration's own body (a re-apply)
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = to_regprocedure('public.collabbox_name_key(text)')
                AND md5(replace(p.prosrc, chr(13), '')) <> 'de92e16b467038b48cc9d4d12b1c7aec') THEN
    RAISE EXCEPTION 'phoneless twin: public.collabbox_name_key(text) exists with another body';
  END IF;
  IF to_regprocedure('public.mk_geo_norm(text)') IS NULL
     OR to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'phoneless twin: apply 20260940000000 (mk_geo_norm) and 20260944000500 (collabbox_sale_at) first';
  END IF;
END
$drift$;

-- ── 1. the name fold ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_name_key(p_name text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $function$
  -- every word folded to Latin letters (mk_geo_norm: Cyrillic → Latin, digraphs, accents),
  -- digits / punctuation split words, one-letter words dropped, distinct, sorted;
  -- NULL below two words (a first name alone proves nothing)
  SELECT CASE WHEN count(*) >= 2 THEN string_agg(s.t, ' ' ORDER BY s.t) END
    FROM (SELECT DISTINCT public.mk_geo_norm(w) AS t
            FROM regexp_split_to_table(coalesce(p_name, ''), '[[:space:][:punct:][:digit:]]+') AS w) s
   WHERE length(s.t) >= 2;
$function$;

COMMENT ON FUNCTION public.collabbox_name_key(text) IS
  'A customer name folded for comparison (20260944000630): words → mk_geo_norm (Cyrillic → Latin, digraphs, accents), digits / punctuation split words, one-letter words dropped, distinct, sorted, space-joined; NULL below two words. "Никола Николовски" = "Nikola Nikolovski". Read by insights_sale_rows (the phoneless collabBox twin).';

REVOKE ALL ON FUNCTION public.collabbox_name_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collabbox_name_key(text) TO authenticated, service_role;
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.collabbox_name_key(text) TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 2. THE cohort's rows: the phoneless twin by the booking time, and by name ─
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

-- ── 3. the writer: the twin window around the sale time ─────────────────────
CREATE OR REPLACE FUNCTION public.collabbox_apply_one(p_run uuid, p_doc jsonb, p_dry boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  c_rate      CONSTANT numeric := 61.5;   -- MKD_PER_EUR — FROZEN (CLAUDE.md): never "update" it
  c_delivery  CONSTANT numeric := 150;    -- the MEX delivery fee a COD may include
  c_tol       CONSTANT numeric := 3;      -- ден
  c_no_items  CONSTANT text := 'collabBox: без ставки (непознат производ)';
  _doc        text := nullif(btrim(p_doc ->> 'doc_number'), '');
  _type       text := nullif(btrim(p_doc ->> 'type_id'), '');
  _role       text;
  _doc_at     timestamptz;
  _amount     numeric;
  _author     text := nullif(regexp_replace(btrim(coalesce(p_doc ->> 'author', '')), '\s+', ' ', 'g'), '');
  _kom        text := nullif(btrim(p_doc ->> 'komitent_id'), '');
  _kname      text := nullif(btrim(p_doc ->> 'komitent_name'), '');
  _lines      jsonb := CASE WHEN jsonb_typeof(p_doc -> 'lines') = 'array' THEN p_doc -> 'lines' ELSE '[]'::jsonb END;
  _complete   boolean := coalesce((p_doc ->> 'lines_complete')::boolean, false);
  _storno     boolean := coalesce((p_doc ->> 'storno')::boolean, false);
  _card       jsonb := CASE WHEN jsonb_typeof(p_doc -> 'komitent') = 'object' THEN p_doc -> 'komitent' END;
  _flags      text[] := ARRAY(SELECT jsonb_array_elements_text(
                           CASE WHEN jsonb_typeof(p_doc -> 'flags') = 'array' THEN p_doc -> 'flags' ELSE '[]'::jsonb END));
  _nlines     integer := 0;
  _goods      numeric := 0;
  _delivery   numeric := 0;
  _unmapped   integer := 0;
  _notes      text[];
  _goods_l    jsonb := '[]'::jsonb;
  _top        uuid;
  _pname      text;
  _qty        integer := 1;
  _person     uuid;
  _ext        text;
  _prev       public.collabbox_documents%ROWTYPE;
  _has_prev   boolean := false;
  _o          record;
  _has_o      boolean := false;
  _p          public.mex_parcels%ROWTYPE;
  _has_p      boolean := false;
  _cc         public.collabbox_customers%ROWTYPE;
  _has_cc     boolean := false;
  _tic        record;
  _has_tic    boolean := false;
  _holder     uuid;
  _outcome    text;
  _reason     text;
  _order_id   uuid;
  _related    uuid;
  _credit     text;
  _status     text;
  _basis      text;
  _paid_at    timestamptz;
  _shipped_at timestamptz;
  _sent_at    timestamptz;                -- when the parcel was created at MEX (orders.mex_sent_at)
  _ret_at     timestamptz;
  _p8         text;
  _psrc       text;
  _phone      text;
  _cname      text;
  _city       text;
  _address    text;
  _skip       text;
  _price      numeric;
  _link       text;
  _dept       text[];
  _created    boolean := false;
  _changed    boolean := false;
  _orig       text;
  _svalue     numeric;
  _note_head  text;
  _booked     timestamptz;                -- when the operator BOOKED it (collabbox_documents.booked_at)
  _bbasis     text;
  _sale_at    timestamptz;                -- THE sale time: collabbox_sale_at(doc_at, booked_at) — 20260944000500
BEGIN
  IF _doc IS NULL THEN
    RAISE EXCEPTION 'collabbox: a document without doc_number' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF _type IS NULL OR _type !~ '^[0-9]{3,8}$' THEN
    RAISE EXCEPTION 'collabbox: % has no type id', _doc USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _doc_at := public.collabbox_parse_local(p_doc ->> 'doc_at');
  IF _doc_at IS NULL THEN
    RAISE EXCEPTION 'collabbox: % has no parseable doc_at (%)', _doc, left(p_doc ->> 'doc_at', 40)
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _role   := public.collabbox_doc_role(_type);
  _amount := public.collabbox_num(p_doc ->> 'amount_mkd');

  -- ── the lines, as the function classified them (a product id must exist) ──
  SELECT count(*)::integer,
         coalesce(sum(s.v) FILTER (WHERE s.r = 'goods'), 0),
         coalesce(sum(s.v) FILTER (WHERE s.r = 'delivery'), 0),
         count(*) FILTER (WHERE s.r = 'goods' AND s.pid IS NULL AND (s.q > 0 OR s.v > 0))::integer,
         array_agg(s.raw ORDER BY s.ord) FILTER (WHERE s.r = 'note' AND s.raw <> ''),
         coalesce(jsonb_agg(jsonb_build_object('product_id', s.pid, 'name', s.nm, 'qty', s.q, 'value_mkd', s.v)
                            ORDER BY s.ord) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), '[]'::jsonb),
         (array_agg(s.pid ORDER BY s.v DESC, s.ord) FILTER (WHERE s.r = 'goods' AND s.pid IS NOT NULL))[1],
         left(string_agg(s.nm, ' + ' ORDER BY s.ord) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), 300),
         greatest(coalesce(sum(greatest(ceil(s.q), 1)) FILTER (WHERE s.r = 'goods' AND (s.q > 0 OR s.v > 0)), 0), 1)::integer
    INTO _nlines, _goods, _delivery, _unmapped, _notes, _goods_l, _top, _pname, _qty
    FROM (SELECT x.ord,
                 CASE WHEN x.l ->> 'role' IN ('goods', 'delivery', 'note', 'marker') THEN x.l ->> 'role' ELSE 'note' END AS r,
                 pr.id AS pid,
                 left(coalesce(nullif(btrim(x.l ->> 'product_name'), ''), nullif(btrim(x.l ->> 'name'), ''), '—'), 300) AS nm,
                 left(btrim(coalesce(x.l ->> 'name', '')), 500) AS raw,
                 coalesce(public.collabbox_num(x.l ->> 'qty'), 0) AS q,
                 coalesce(public.collabbox_num(x.l ->> 'value_mkd'), 0) AS v
            FROM jsonb_array_elements(_lines) WITH ORDINALITY AS x(l, ord)
            LEFT JOIN public.products pr   -- CASE: the cast never runs on a malformed id
              ON pr.id = CASE WHEN (x.l ->> 'product_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                              THEN (x.l ->> 'product_id')::uuid END) s;

  SELECT i.person_id, i.ext INTO _person, _ext FROM public.collabbox_author_identity(_author) i;
  _dept := public.collabbox_department(_type, _doc, _person, _doc_at);

  SELECT * INTO _prev FROM public.collabbox_documents WHERE doc_number = _doc;
  _has_prev := FOUND;

  -- the BOOKING time (owner 01.10.2026: a sale counts on the day the operator booked it; doc_at is the
  -- dispatch day). A known document keeps what its first sighting decided (a row from before
  -- 20260944000500 reads as doc_at until the backfill); a new one is decided now.
  IF _has_prev THEN
    _booked := least(coalesce(_prev.booked_at, _doc_at), _doc_at);
    _bbasis := CASE WHEN _prev.booked_at IS NOT NULL THEN _prev.booked_at_basis END;
  ELSE
    SELECT e.booked_at, e.basis INTO _booked, _bbasis
      FROM public.collabbox_estimate_booked_at(_doc, _doc_at, now(), p_run) e;
  END IF;
  _booked := coalesce(_booked, _doc_at);
  _sale_at := public.collabbox_sale_at(_doc_at, _booked);

  SELECT o.id, o.status::text AS status, o.price, o.packed_at, o.mex_status_id, o.mex_tracking_id,
         o.collabbox_doc_type, o.sold_at, o.sold_via, o.sold_by_ext, o.sold_by_person_id
    INTO _o
    FROM public.orders o
   WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
  _has_o := FOUND;

  SELECT * INTO _p FROM public.mex_parcels WHERE tracking_id = _doc;
  _has_p := FOUND;

  <<decide>>
  LOOP
    -- ── A. a storno: recorded, never an order; the document it reverses is marked ──
    IF _storno THEN
      _outcome := 'storno';
      SELECT abs(sum(coalesce(public.collabbox_num(l ->> 'value_mkd'), 0)))
        INTO _svalue
        FROM jsonb_array_elements(_lines) l
       WHERE coalesce(public.collabbox_num(l ->> 'value_mkd'), 0) < 0;
      _svalue := coalesce(nullif(_svalue, 0), abs(_amount));
      _orig := nullif(btrim(p_doc ->> 'reverses'), '');
      IF _orig IS NULL AND _kom IS NOT NULL AND coalesce(_svalue, 0) > 0 THEN
        -- the same komitent's earlier document worth exactly that, ≤ 120 days back — only when ONE fits
        SELECT CASE WHEN count(*) = 1 THEN min(c.doc) END INTO _orig
          FROM (SELECT d.doc_number AS doc
                  FROM public.collabbox_documents d
                 WHERE d.komitent_id = _kom AND d.doc_number <> _doc AND NOT d.is_storno
                   AND d.reversed_by IS NULL AND d.vanished_at IS NULL
                   AND abs(coalesce(d.amount_mkd, 0) - _svalue) <= 1
                   AND d.doc_at <= _doc_at AND d.doc_at >= _doc_at - interval '120 days'
                UNION
                SELECT t.doc_number
                  FROM public.teleshop_import_documents t
                 WHERE t.komitent_id = _kom AND t.doc_number <> _doc
                   AND NOT (t.outcome = 'skipped' AND t.reason IN ('storno', 'reversed_by_storno'))
                   AND abs(coalesce(t.amount_mkd, 0) - _svalue) <= 1
                   AND t.doc_at <= _doc_at AND t.doc_at >= _doc_at - interval '120 days') c;
      END IF;
      IF _orig IS NULL THEN
        _reason := 'storno_unmatched';
        EXIT decide;
      END IF;
      _reason := 'reverses:' || _orig;
      SELECT d.order_id INTO _related
        FROM public.collabbox_documents d
       WHERE d.doc_number = _orig AND d.created_by_sync AND d.order_id IS NOT NULL;
      IF _related IS NOT NULL THEN
        _flags := _flags || 'storno_marks_sync_order'::text;
        _note_head := 'collabBox storno ' || _doc || ' ';
        IF NOT p_dry THEN
          INSERT INTO public.order_notes (order_id, text, author_id, author_name)
          SELECT _related,
                 _note_head || format('(%s) reverses document %s. The order is left as it is (its status comes from MEX) — check it and cancel it if it never shipped.',
                                      to_char(_doc_at AT TIME ZONE 'Europe/Skopje', 'DD.MM.YYYY HH24:MI'), _orig),
                 NULL, 'collabBox'
           WHERE NOT EXISTS (SELECT 1 FROM public.order_notes n
                              WHERE n.order_id = _related AND left(n.text, length(_note_head)) = _note_head);
        END IF;
      ELSE
        SELECT t.order_id INTO _related
          FROM public.teleshop_import_documents t
         WHERE t.doc_number = _orig AND t.outcome IN ('created', 'exists', 'enriched') AND t.order_id IS NOT NULL;
        IF _related IS NOT NULL THEN
          _flags := _flags || 'storno_original_imported'::text;
        END IF;
      END IF;
      IF NOT p_dry THEN
        UPDATE public.collabbox_documents d
           SET reversed_by = _doc,
               flags = CASE WHEN 'reversed_by_storno' = ANY (d.flags) THEN d.flags ELSE d.flags || 'reversed_by_storno'::text END,
               updated_at = now()
         WHERE d.doc_number = _orig AND d.reversed_by IS DISTINCT FROM _doc;
      END IF;
      EXIT decide;
    END IF;

    -- ── B. record-only types ────────────────────────────────────────────────
    IF _role = 'record' THEN
      _outcome := 'recorded';
      _order_id := CASE WHEN _has_o THEN _o.id END;
      EXIT decide;
    END IF;

    -- ── C. the document already IS an order (the idempotency key) ────────────
    IF _has_o THEN
      _order_id := _o.id;
      IF _o.collabbox_doc_type IS NULL THEN
        _changed := true;
        IF NOT p_dry THEN
          UPDATE public.orders SET collabbox_doc_type = _type WHERE id = _o.id AND collabbox_doc_type IS NULL;
        END IF;
      ELSIF _o.collabbox_doc_type <> _type THEN
        _flags := _flags || ('type_changed:' || _o.collabbox_doc_type || '>' || _type);  -- listed; the department is write-once
      END IF;
      IF _o.sold_at IS NULL AND _o.sold_via IS NULL AND _o.sold_by_ext IS NULL AND _o.sold_by_person_id IS NULL THEN
        _credit := public.collabbox_credit_order(_o.id, _doc, _sale_at, _author, p_dry);
        IF _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN _changed := true; END IF;
      END IF;
      -- edited in collabBox before it shipped — only an order THIS sync created, still to pack
      IF _has_prev AND _prev.created_by_sync AND _o.status = 'confirmed' AND _o.packed_at IS NULL
         AND _o.mex_status_id IS NULL AND _complete THEN
        _price := round(CASE WHEN _nlines > 0 THEN _goods ELSE coalesce(_amount, 0) END / c_rate, 2);
        IF _price > 0 AND abs(_price - coalesce(_o.price, 0)) >= 0.01 THEN
          _changed := true;
          _flags := _flags || 'edited_before_packing'::text;
          IF NOT p_dry THEN
            UPDATE public.orders o
               SET price = _price, quantity = _qty,
                   product_name = coalesce(_pname, o.product_name), product_id = coalesce(_top, o.product_id)
             WHERE o.id = _o.id AND o.status = 'confirmed';
            IF jsonb_array_length(_goods_l) > 0 THEN
              DELETE FROM public.order_items WHERE order_id = _o.id;
              INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
              SELECT _o.id, i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price, _doc_at
                FROM public.collabbox_items(_goods_l, _price) i;
            END IF;
            INSERT INTO public.order_notes (order_id, text, author_id, author_name)
            VALUES (_o.id, format('collabBox document %s was edited before packing — price %s → %s EUR.', _doc, _o.price, _price),
                    NULL, 'collabBox');
          END IF;
        END IF;
      ELSIF _has_prev AND _prev.created_by_sync AND _o.status <> 'confirmed'
            AND _amount IS DISTINCT FROM _prev.amount_mkd THEN
        _flags := _flags || 'amount_edited_after_shipping'::text;   -- MEX decides; listed
      END IF;
      IF nullif(p_doc ->> 'reversed_by', '') IS NOT NULL OR (_has_prev AND _prev.reversed_by IS NOT NULL) THEN
        _flags := _flags || 'reversed_by_storno'::text;
      END IF;
      _outcome := CASE WHEN _changed THEN 'updated' ELSE 'exists' END;
      EXIT decide;
    END IF;

    -- ── D. Нарачка LEADS: never an order — credit the order holding its parcel ──
    IF _role = 'credit' THEN
      _holder := CASE WHEN _has_p THEN _p.order_id END;
      IF _holder IS NULL THEN
        SELECT CASE WHEN count(*) = 1 THEN (array_agg(o.id))[1] END INTO _holder
          FROM public.orders o WHERE o.mex_tracking_id = _doc;
      END IF;
      IF coalesce(_amount, 0) <= 0 THEN
        _outcome := 'replacement'; _reason := 'replacement_zero_value'; _related := _holder;
        EXIT decide;
      END IF;
      IF _holder IS NULL THEN
        _outcome := 'credit_pending';
        _reason := CASE WHEN _has_p THEN 'parcel_not_linked_yet' ELSE 'no_parcel_yet' END;
        EXIT decide;
      END IF;
      _related := _holder;
      _credit := public.collabbox_credit_order(_holder, _doc, _sale_at, _author, p_dry);
      _outcome := CASE WHEN _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN 'credited' ELSE 'recorded' END;
      _reason := 'credit_' || coalesce(_credit, 'none');
      EXIT decide;
    END IF;

    -- ── E. an order document (10036 · 10050 · 10106) or LEADS-OUT (10114) ─────
    IF nullif(p_doc ->> 'reversed_by', '') IS NOT NULL OR (_has_prev AND _prev.reversed_by IS NOT NULL) THEN
      _outcome := 'skipped'; _reason := 'reversed_by_storno';
      EXIT decide;
    END IF;
    IF 'duplicate_doc_number' = ANY (_flags) THEN
      _outcome := 'skipped'; _reason := 'duplicate_doc_number';
      EXIT decide;
    END IF;
    IF _doc !~ '^[0-9]{3}-[0-9]{4}-[0-9]+/[0-9]{4}$' THEN
      _outcome := 'skipped'; _reason := 'bad_doc_number';
      EXIT decide;
    END IF;
    IF NOT _complete THEN
      _outcome := 'no_items'; _reason := 'line_items_not_read';
      EXIT decide;
    END IF;
    IF _amount IS NULL THEN
      _outcome := 'skipped'; _reason := 'no_amount';
      EXIT decide;
    END IF;
    IF _nlines = 0 THEN
      _goods := _amount;                               -- a document without lines: its header amount
      _flags := _flags || 'no_items_in_document'::text;
    END IF;
    IF _amount <= 0 OR _goods <= 0 THEN
      _outcome := 'replacement'; _reason := 'replacement_zero_value';
      EXIT decide;
    END IF;
    IF _has_p AND coalesce(_p.cod_mkd, 0) <= 0 THEN
      _outcome := 'replacement'; _reason := 'replacement_cod0';
      EXIT decide;
    END IF;

    -- who else holds / names this parcel
    _holder := CASE WHEN _has_p THEN _p.order_id END;
    IF _holder IS NOT NULL THEN
      _reason := 'parcel_held_by_other_order';
    ELSE
      SELECT o.id INTO _holder FROM public.orders o WHERE o.mex_tracking_id = _doc ORDER BY o.created_at LIMIT 1;
      IF _holder IS NOT NULL THEN _reason := 'tracking_named_by_other_order'; END IF;
    END IF;
    IF _holder IS NOT NULL THEN
      _related := _holder;
      IF _role = 'order_unless_held' THEN
        _credit := public.collabbox_credit_order(_holder, _doc, _sale_at, _author, p_dry);
        _outcome := CASE WHEN _credit IN ('stamped', 'stamped_no_person', 'person_filled') THEN 'credited' ELSE 'recorded' END;
        _reason := _reason || ';credit_' || coalesce(_credit, 'none');
      ELSE
        _outcome := 'conflict';                         -- never a second order, never a forced link
      END IF;
      EXIT decide;
    END IF;
    IF _has_p AND EXISTS (SELECT 1 FROM public.web_orders w
                           WHERE w.mex_tracking_id = _doc AND w.deleted_in_shop_at IS NULL) THEN
      _outcome := 'conflict'; _reason := 'parcel_claimed_by_web_order';
      EXIT decide;
    END IF;
    IF _has_p AND _p.created_at_mex IS NOT NULL AND _p.created_at_mex < _doc_at THEN
      _outcome := 'conflict'; _reason := 'parcel_predates_document';   -- never linked to a later order
      EXIT decide;
    END IF;
    -- No parcel yet → wait (retried 14 nights), never a "to pack" CRM order: teleshop, social and
    -- LEADS-OUT are packed in collabBox, so a sync order without a parcel would sit in the CRM
    -- warehouse's Packing queue (a double-pack risk). Until the parcel exists the booking is seen
    -- through collabbox_booked_today() (the leaderboard). Main session, 29.09.2026.
    IF _role IN ('order', 'order_unless_held') AND NOT _has_p THEN
      _outcome := 'awaiting_parcel';
      _reason := CASE WHEN _role = 'order_unless_held' THEN 'leads_out_waits_for_its_parcel' ELSE 'waits_for_its_parcel' END;
      EXIT decide;
    END IF;

    -- ── the customer: the card read tonight / stored, the teleshop registry, the parcel ──
    IF _kom IS NOT NULL THEN
      SELECT * INTO _cc FROM public.collabbox_customers WHERE komitent_id = _kom;
      _has_cc := FOUND;
    END IF;
    IF _card IS NOT NULL THEN
      _p8 := public.collabbox_mk_phone8(_card ->> 'phone8');
      _skip := nullif(btrim(_card ->> 'skip_reason'), '');
      _cname := nullif(btrim(_card ->> 'name'), '');
      _city := nullif(btrim(_card ->> 'city'), '');
      _address := nullif(btrim(_card ->> 'address'), '');
      IF jsonb_typeof(_card -> 'flags') = 'array' AND (_card -> 'flags') ? 'do_not_contact' THEN
        _flags := _flags || 'banned_customer_do_not_contact'::text;
      END IF;
    ELSIF _has_cc AND _cc.source = 'card' THEN
      _p8 := public.collabbox_mk_phone8(_cc.phone8);
      _skip := _cc.skip_reason;
      _cname := nullif(btrim(_cc.name), '');
      _city := nullif(btrim(_cc.city), '');
      _address := nullif(btrim(_cc.address), '');
      IF 'do_not_contact' = ANY (_cc.flags) THEN _flags := _flags || 'banned_customer_do_not_contact'::text; END IF;
    END IF;
    IF _p8 IS NOT NULL THEN _psrc := 'card'; END IF;
    IF _kom IS NOT NULL THEN
      SELECT t.phone8, t.outcome, t.reason, t.name INTO _tic
        FROM public.teleshop_import_customers t WHERE t.komitent_id = _kom;
      _has_tic := FOUND;
      IF _has_tic THEN
        IF _p8 IS NULL AND public.collabbox_mk_phone8(_tic.phone8) IS NOT NULL THEN
          _p8 := _tic.phone8; _psrc := 'teleshop_import';
        END IF;
        IF _skip IS NULL AND _tic.outcome = 'skipped'
           AND _tic.reason IN ('deceased', 'employee', 'company', 'operator_account', 'do_not_ship',
                               'junk_name', 'wrong_number', 'test_name') THEN
          _skip := _tic.reason;
        END IF;
        _cname := coalesce(_cname, nullif(btrim(_tic.name), ''));
      END IF;
    END IF;
    -- a komitent nobody knows yet (no card, not in the teleshop registry): its header name decides
    IF _card IS NULL AND NOT (_has_cc AND _cc.source = 'card') AND NOT _has_tic THEN
      _skip := coalesce(_skip, nullif(btrim(p_doc ->> 'name_skip'), ''));
      IF jsonb_typeof(p_doc -> 'name_flags') = 'array' AND (p_doc -> 'name_flags') ? 'do_not_contact'
         AND NOT ('banned_customer_do_not_contact' = ANY (_flags)) THEN
        _flags := _flags || 'banned_customer_do_not_contact'::text;
      END IF;
    END IF;
    IF _has_p AND public.collabbox_mk_phone8(_p.phone8) IS NOT NULL THEN
      IF _p8 IS NULL THEN
        _p8 := _p.phone8; _psrc := 'parcel';
      ELSIF _p8 <> _p.phone8 THEN
        _flags := _flags || 'phone_differs_from_parcel'::text;
      END IF;
    END IF;
    IF _p8 IS NULL AND _has_cc AND _cc.source = 'parcel' AND public.collabbox_mk_phone8(_cc.phone8) IS NOT NULL THEN
      _p8 := _cc.phone8; _psrc := 'parcel_registry';
    END IF;
    _cname := left(coalesce(_cname, _kname, nullif(btrim(CASE WHEN _has_p THEN _p.receiver_name END), ''), '—'), 200);
    _city := left(coalesce(_city, nullif(btrim(CASE WHEN _has_p THEN _p.receiver_city END), ''), ''), 120);
    _address := left(coalesce(_address, ''), 600);

    IF _skip IS NOT NULL THEN
      _outcome := 'skipped'; _reason := 'komitent_' || _skip;
      EXIT decide;
    END IF;
    IF _p8 IS NULL THEN
      _outcome := 'no_phone';
      _reason := CASE WHEN _kom IS NULL THEN 'no_komitent'
                      WHEN _card IS NULL AND NOT _has_cc THEN 'komitent_card_not_read'
                      ELSE 'no_valid_macedonian_phone' END;
      EXIT decide;
    END IF;
    IF public.is_report_excluded_phone(_p8) THEN
      _outcome := 'skipped'; _reason := 'test_phone';
      EXIT decide;
    END IF;
    _phone := '+389' || _p8;

    -- ── the same sale already in the CRM (a twin) → never a second order ─────
    -- its window is around THE sale time (the booking), not doc_at: the dispatch day of a copy
    -- booked days ahead is days after the CRM sale (20260944000630)
    SELECT o.id INTO _related
      FROM public.orders o
     WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = _p8
       AND o.external_source IS DISTINCT FROM 'collabbox'
       AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
       AND o.mex_tracking_id IS NULL
       AND o.price > 0
       AND NOT public.is_synthetic_product_name(o.product_name)
       AND o.sale_source_detail IS DISTINCT FROM 'disposition'
       AND o.created_at >= _sale_at - interval '1 day'
       AND o.created_at <= _sale_at + interval '2 days'
       AND (abs(round(o.price * c_rate) - _amount) <= c_tol
            OR abs(round(o.price * c_rate) + c_delivery - _amount) <= c_tol
            OR abs(round(o.price * c_rate) - round(_goods)) <= c_tol)
     ORDER BY abs(extract(epoch FROM o.created_at - _sale_at)), o.created_at
     LIMIT 1;
    IF _related IS NOT NULL THEN
      _outcome := 'conflict'; _reason := 'possible_twin_crm_sale';
      EXIT decide;
    END IF;
    IF EXISTS (SELECT 1 FROM public.orders o
                WHERE right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = _p8
                  AND o.external_source IS DISTINCT FROM 'collabbox'
                  AND o.status::text IN ('pending', 'take', 'call_again', 'confirmed', 'shipped', 'delivered', 'paid', 'returned')
                  AND o.mex_tracking_id IS NULL AND o.price > 0
                  AND o.created_at >= _sale_at - interval '3 days' AND o.created_at <= _sale_at + interval '3 days') THEN
      _flags := _flags || 'near_crm_sale_price_differs'::text;   -- not the owner's twin rule: listed, created
    END IF;

    -- ── price and status — MEX decides the status, never collabBox ──────────
    _price := round(_goods / c_rate, 2);
    IF _has_p AND _p.cod_mkd > 0
       AND NOT (abs(_p.cod_mkd - round(_goods)) <= c_tol OR abs(_p.cod_mkd - round(_goods) - c_delivery) <= c_tol) THEN
      _price := round(_p.cod_mkd / c_rate, 2);                     -- COD ≠ price → MEX is right
      _flags := _flags || 'price_from_cod'::text;
    END IF;
    IF _nlines > 0 AND abs(_amount - round(_goods) - round(_delivery)) > c_tol THEN
      _flags := _flags || 'lines_differ_from_amount'::text;
    END IF;
    IF _has_p THEN
      -- MEX 8 "Shipment created" = за пакување: the order stays confirmed until the courier takes it
      -- (4/10/9/1/3 → shipped). Owner 30.09.2026; mex-reconcile applies the same rule (match.ts targetFor).
      _status := CASE _p.status_id WHEN 2 THEN 'paid' WHEN 7 THEN 'returned' WHEN 8 THEN 'confirmed' ELSE 'shipped' END;
      _sent_at := coalesce(_p.created_at_mex, _doc_at);
      _shipped_at := CASE WHEN _status = 'confirmed' THEN NULL ELSE _sent_at END;
      IF _status = 'paid' THEN
        _paid_at := coalesce(_p.delivered_at, _p.last_update_at, _shipped_at);
        _basis := 'mex';
      ELSIF _status = 'returned' THEN
        _ret_at := coalesce(_p.returned_at, _p.last_update_at, _shipped_at);
      END IF;
    ELSE
      _status := 'confirmed';                                      -- to pack; mex-reconcile takes over
    END IF;
    IF _author IS NULL THEN _flags := _flags || 'no_author'::text;
    ELSIF _person IS NULL THEN _flags := _flags || 'author_unmapped'::text;
    END IF;
    _outcome := 'created';
    _reason := CASE WHEN _has_p AND _status = 'confirmed' THEN 'parcel_to_pack' WHEN _has_p THEN 'parcel_' || _status ELSE 'to_pack' END;

    IF NOT p_dry THEN
      BEGIN
        INSERT INTO public.orders (
               product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
               price, quantity, status, source_type, external_source, external_order_id, delivery_type,
               created_at, confirmed_at, sold_at, sold_via, sold_by_ext, sold_by_person_id,
               mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at, collabbox_doc_type, mex_sent_at)
        VALUES (_top, coalesce(_pname, c_no_items), _cname, _phone, _city, _address,
                _price, _qty, _status::public.order_status, 'import', 'collabbox', _doc, 'home',
                _sale_at, _sale_at,                       -- created / confirmed = the booking (20260944000500)
                CASE WHEN _ext IS NOT NULL THEN _sale_at END,
                CASE WHEN _ext IS NOT NULL THEN 'collabbox' END,
                _ext, _person,
                _doc, _paid_at, _basis, _shipped_at, _ret_at, _type, _sent_at)
        ON CONFLICT (external_source, external_order_id) WHERE external_order_id IS NOT NULL DO NOTHING
        RETURNING id INTO _order_id;

        IF _order_id IS NULL THEN
          -- another writer created it a moment ago: this document is an order now
          SELECT o.id INTO _order_id FROM public.orders o
           WHERE o.external_source = 'collabbox' AND o.external_order_id = _doc;
          _outcome := 'exists'; _reason := 'created_concurrently';
        ELSE
          _created := true;
          IF jsonb_array_length(_goods_l) > 0 THEN
            INSERT INTO public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
            SELECT _order_id, i.product_id, i.product_name, i.quantity, i.price_per_unit, i.total_price, _doc_at
              FROM public.collabbox_items(_goods_l, _price) i;
          END IF;
          INSERT INTO public.order_notes (order_id, text, author_id, author_name, created_at)
          SELECT _order_id, 'collabBox: ' || n, NULL, 'collabBox', _doc_at
            FROM unnest(coalesce(_notes, '{}'::text[])) n;
          INSERT INTO public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
          VALUES (_order_id, NULL, _status::public.order_status, NULL, 'System (collabbox-sync)');
          INSERT INTO public.customer_profiles (phone, customer_name, city, street)
          VALUES (_phone, nullif(_cname, '—'), nullif(_city, ''), nullif(_address, ''))
          ON CONFLICT (phone) DO NOTHING;
          IF _has_p THEN
            -- trg_orders_link_parcel already claimed the FREE parcel ('unknown_writer');
            -- this names the method. Anything else = another linker won since the check.
            _link := public.mex_link_parcel(_doc, _order_id, 'collabbox_import', false);
            IF _link IS DISTINCT FROM 'linked' AND _link IS DISTINCT FROM 'already' THEN
              RAISE EXCEPTION 'collabbox: parcel % → %', _doc, coalesce(_link, 'null') USING ERRCODE = 'P0CBX';
            END IF;
          END IF;
        END IF;
      EXCEPTION WHEN SQLSTATE 'P0CBX' THEN
        _created := false;
        _order_id := NULL;
        _outcome := 'conflict';
        _reason := 'parcel_claimed_concurrently';
        SELECT m.order_id INTO _related FROM public.mex_parcels m WHERE m.tracking_id = _doc;
      END;
    END IF;
    EXIT decide;
  END LOOP;

  -- ── the komitent registry (not in a dry run) ──────────────────────────────
  IF NOT p_dry AND _kom IS NOT NULL THEN
    IF _card IS NOT NULL THEN
      INSERT INTO public.collabbox_customers AS c
             (komitent_id, object_id, name, phone8, phone_field, phone_raw, city, address, skip_reason, flags, source, run_id)
      VALUES (_kom, nullif(btrim(_card ->> 'object_id'), ''), nullif(btrim(_card ->> 'name'), ''),
              public.collabbox_mk_phone8(_card ->> 'phone8'), nullif(btrim(_card ->> 'phone_field'), ''),
              left(nullif(btrim(_card ->> 'phone_raw'), ''), 200), nullif(btrim(_card ->> 'city'), ''),
              left(nullif(btrim(_card ->> 'address'), ''), 600), nullif(btrim(_card ->> 'skip_reason'), ''),
              ARRAY(SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(_card -> 'flags') = 'array'
                                                          THEN _card -> 'flags' ELSE '[]'::jsonb END)),
              'card', p_run)
      ON CONFLICT (komitent_id) DO UPDATE
         SET object_id = coalesce(EXCLUDED.object_id, c.object_id), name = coalesce(EXCLUDED.name, c.name),
             phone8 = EXCLUDED.phone8, phone_field = EXCLUDED.phone_field, phone_raw = EXCLUDED.phone_raw,
             city = coalesce(EXCLUDED.city, c.city), address = coalesce(EXCLUDED.address, c.address),
             skip_reason = EXCLUDED.skip_reason, flags = EXCLUDED.flags, source = 'card',
             run_id = EXCLUDED.run_id, updated_at = now();
    ELSIF _psrc = 'parcel' AND NOT _has_cc THEN
      INSERT INTO public.collabbox_customers (komitent_id, name, phone8, phone_field, city, source, run_id)
      VALUES (_kom, nullif(_cname, '—'), _p8, 'parcel', nullif(_city, ''), 'parcel', p_run)
      ON CONFLICT (komitent_id) DO NOTHING;
    END IF;
  END IF;

  -- ── the ledger row (not in a dry run) ──────────────────────────────────────
  IF NOT p_dry THEN
    INSERT INTO public.collabbox_documents AS d (
           doc_number, doc_id, object_id, doc_type_id, doc_type_name, role, doc_at, komitent_id, komitent_name,
           author, author_person_id, amount_mkd, goods_mkd, delivery_mkd, price_eur, lines_n, lines_complete,
           unmapped_lines, is_storno, reverses_doc, reversed_by, phone8, phone_source, customer_phone,
           outcome, reason, department, planned_status, paid_basis, parcel_status_id, parcel_cod_mkd,
           order_id, related_order_id, created_by_sync, created_run_id, credit, flags, attempts,
           first_run_id, run_id, first_seen_at, last_seen_at, vanished_at, payload, updated_at,
           booked_at, booked_at_basis)
    VALUES (_doc, nullif(btrim(p_doc ->> 'doc_id'), ''), nullif(btrim(p_doc ->> 'object_id'), ''), _type,
            nullif(btrim(p_doc ->> 'type_name'), ''), _role, _doc_at, _kom, _kname,
            _author, _person, _amount, CASE WHEN _role <> 'record' OR _nlines > 0 THEN _goods END, _delivery,
            CASE WHEN _outcome IN ('created', 'updated') THEN _price END, _nlines, _complete,
            _unmapped, _storno, CASE WHEN _storno THEN _orig END, nullif(btrim(p_doc ->> 'reversed_by'), ''),
            _p8, _psrc, _phone, _outcome, _reason, _dept,
            CASE WHEN _outcome = 'created' THEN _status END, CASE WHEN _outcome = 'created' THEN _basis END,
            CASE WHEN _has_p THEN _p.status_id END, CASE WHEN _has_p THEN _p.cod_mkd END,
            _order_id, _related, _created, CASE WHEN _created THEN p_run END, _credit,
            coalesce(_flags, '{}'::text[]), 1, p_run, p_run, now(), now(), NULL, p_doc, now(),
            _booked, _bbasis)                     -- decided once: ON CONFLICT never rewrites it
    ON CONFLICT (doc_number) DO UPDATE
       SET doc_id           = coalesce(EXCLUDED.doc_id, d.doc_id),
           object_id        = coalesce(EXCLUDED.object_id, d.object_id),
           doc_type_id      = EXCLUDED.doc_type_id,
           doc_type_name    = coalesce(EXCLUDED.doc_type_name, d.doc_type_name),
           role             = EXCLUDED.role,
           doc_at           = EXCLUDED.doc_at,
           komitent_id      = EXCLUDED.komitent_id,
           komitent_name    = coalesce(EXCLUDED.komitent_name, d.komitent_name),
           author           = EXCLUDED.author,
           author_person_id = EXCLUDED.author_person_id,
           amount_mkd       = EXCLUDED.amount_mkd,
           goods_mkd        = EXCLUDED.goods_mkd,
           delivery_mkd     = EXCLUDED.delivery_mkd,
           price_eur        = coalesce(EXCLUDED.price_eur, d.price_eur),
           lines_n          = EXCLUDED.lines_n,
           lines_complete   = EXCLUDED.lines_complete,
           unmapped_lines   = EXCLUDED.unmapped_lines,
           is_storno        = EXCLUDED.is_storno,
           reverses_doc     = coalesce(EXCLUDED.reverses_doc, d.reverses_doc),
           reversed_by      = coalesce(d.reversed_by, EXCLUDED.reversed_by),
           phone8           = coalesce(EXCLUDED.phone8, d.phone8),
           phone_source     = coalesce(EXCLUDED.phone_source, d.phone_source),
           customer_phone   = coalesce(EXCLUDED.customer_phone, d.customer_phone),
           outcome          = EXCLUDED.outcome,
           reason           = EXCLUDED.reason,
           department       = EXCLUDED.department,
           planned_status   = coalesce(EXCLUDED.planned_status, d.planned_status),
           paid_basis       = coalesce(EXCLUDED.paid_basis, d.paid_basis),
           parcel_status_id = EXCLUDED.parcel_status_id,
           parcel_cod_mkd   = EXCLUDED.parcel_cod_mkd,
           order_id         = coalesce(EXCLUDED.order_id, d.order_id),
           related_order_id = EXCLUDED.related_order_id,
           created_by_sync  = d.created_by_sync OR EXCLUDED.created_by_sync,
           created_run_id   = coalesce(d.created_run_id, EXCLUDED.created_run_id),
           credit           = coalesce(EXCLUDED.credit, d.credit),
           flags            = EXCLUDED.flags,
           attempts         = d.attempts + 1,
           first_run_id     = coalesce(d.first_run_id, EXCLUDED.first_run_id),
           run_id           = EXCLUDED.run_id,
           last_seen_at     = now(),
           vanished_at      = NULL,
           payload          = EXCLUDED.payload,
           updated_at       = now();
  END IF;

  RETURN jsonb_build_object(
    'doc', _doc, 'type', _type, 'role', _role, 'outcome', _outcome, 'reason', _reason,
    'order_id', _order_id, 'related_order_id', _related, 'credit', _credit,
    'status', CASE WHEN _outcome = 'created' THEN _status END,
    'price_eur', CASE WHEN _outcome IN ('created', 'updated') THEN _price END,
    'goods_mkd', _goods, 'amount_mkd', _amount, 'lines', _nlines, 'unmapped', _unmapped,
    'phone_source', _psrc, 'department', to_jsonb(_dept), 'author_person', _person,
    'booked_at', _booked, 'booked_at_basis', _bbasis, 'sale_at', _sale_at,
    'flags', to_jsonb(coalesce(_flags, '{}'::text[])));
END;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';
