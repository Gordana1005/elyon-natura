-- The owner's rule of 03.10.2026, for the cohort — so for the TV board (leaderboard_day_v2), Табла /
-- the Insights Overview, Операции, the bonus and every other reader of insights_sale_rows:
--   "Треба реал-тајм да се гледат сите нарачки што се прават без разлика дали ги има или нема во
--    collab, Но после 10 дена се одзимат од tv leaderboard, тие што не се доставени, и тие што не
--    се пуштени никогаш. (return-от) се брои како return, па по тој принцип им се намалува % од бонус."
--
-- 1. 10111 LEADS bookings count at once (bk0 / bk): Во магацин, Тим Маџари In, the author, the booking
--    day — unless the booking is the copy of a living Тим Маџари In sale (an AlterCPA approval with no
--    parcel) on the customer's phone (−30 d … +1 d, amount ignored) or the author's own such sale under
--    the same folded name. ONLY when the customer's phone is known (komitent card → teleshop registry
--    → any stored card). Backtest (exports/leadsrt, read-only, September matured + 19–30.09 with the
--    AlterCPA feed live): with the phone 2 double counts (7.000 ден) of 643 counted bookings in
--    September, 0 on 01–02.10, both explained (a customer with two numbers; a one-digit-off phone);
--    without it the rule as asked (author + collabbox_name_key) double-counts 208 of 677 phoneless
--    bookings of 19–30.09 (649.310 ден) — collabBox komitent names are mostly a first name alone and
--    the operators approve 2–24 h before booking while approving other leads in between. Phoneless
--    LEADS bookings therefore wait for their parcel, as before. The komitent-card lookup that should
--    bring the phone finds nothing in any run (the infocc search ignores its filter: the 10.09 / 01.10
--    harvests got the whole register with name1=А) — see the report; not touched here.
-- 2. Ten Skopje days after the sale day (cohort_unshipped_since() = Skopje midnight of today −
--    no_parcel_rule_days(), today 10 — one knob with the AlterCPA no-parcel rule):
--    (a) a booking with no parcel leaves the bookings (bk: was doc_at ≥ now() − 14 days);
--    (b) a sale of ANY source with no MEX parcel (to pack; 'shipped' in the CRM with no MEX parcel)
--        counts no more — the order is not cancelled, its status not touched;
--    (c) a parcel still at MEX 8 (label, never picked up) counts no more — order or MEX-only.
--    Left alone: a parcel MEX holds in transit / problem (counted until paid / returned), returns
--    (MEX 7 — the monthly bonus return-% cut of 20260947001200 reads them), paid with no parcel
--    (paid_legacy / paid_unproven — not "never sent"), the web shop's own orders (they follow the
--    shop's classification). Today and the last 10 days are untouched.
-- 3. One sale, one day, never twice, never dropped while MEX holds the parcel: a booking whose parcel
--    exists but no order holds it is counted as MEX-only once it leaves the bookings, and a MEX-only
--    parcel now takes the BOOKING day of its collabBox document (collabbox_sale_at — the booking day is
--    the law for the whole ledger since 20260944000620, owner 01.10.2026; the earlier of that and the
--    day MEX created it), not the day MEX created it. Measured 03.10: 1.630 MEX-only parcels of
--    March–October move 1–3 days earlier (mostly 9110 LEADS); across months: 225 (443.606 ден)
--    April → March, 40 June → May, 24 May → April, 5 October → September, 9 more.
-- insights_cohort_order_exceptions gains 'expire_before' (the same instant) so GET /orders' cohort
-- drills (insightsCommon.ts cohortBucketOrFilter) list exactly what the cohort counts.
-- Pure Profit's monthly cache version 7 → 8 (closed months change; the 03:40 nightly rebuilds them).
-- Rollback: exports/leadsrt/20260947001850_rollback.sql (the two live bodies of before this migration,
-- DROP FUNCTION public.cohort_unshipped_since(), the cache version back to 7).

DO $guard$
BEGIN
  IF md5(pg_get_functiondef('public.insights_sale_rows(timestamp with time zone,timestamp with time zone,boolean)'::regprocedure)) <> '7ae2de0c91937c898adae5681b18fda7' THEN
    RAISE EXCEPTION 'insights_sale_rows changed since this migration was written: rebuild it from the live body';
  END IF;
  IF md5(pg_get_functiondef('public.insights_cohort_order_exceptions(timestamp with time zone,timestamp with time zone)'::regprocedure)) <> '95529844dff75b28aa3b77b8b36b7b90' THEN
    RAISE EXCEPTION 'insights_cohort_order_exceptions changed since this migration was written: rebuild it from the live body';
  END IF;
  IF public.insights_profit_cache_version() <> 7 THEN
    RAISE EXCEPTION 'insights_profit_cache_version is not 7 any more: re-read it before bumping';
  END IF;
END
$guard$;

-- The instant before which a sale MEX never took counts no more: Skopje midnight of (today − the
-- no-parcel rule's days). STABLE: one value per statement.
CREATE OR REPLACE FUNCTION public.cohort_unshipped_since()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT (((now() AT TIME ZONE 'Europe/Skopje')::date - public.no_parcel_rule_days())::timestamp
          AT TIME ZONE 'Europe/Skopje')
$function$;
REVOKE ALL ON FUNCTION public.cohort_unshipped_since() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cohort_unshipped_since() TO service_role, supabase_read_only_user;

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
  -- $4 the excluded phones' last-8 digits · $5 cohort_unshipped_since(): a sale made before it
  -- that MEX never took counts no more, 20260947001850); only the last step differs: with the keys it joins the city / product
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
-- Only the tracking ids an order of this window can hold (20260947001500; was every
-- tracking id of all history, ~56k, grouped on each call ≈ 200 ms): c is the same index
-- superset as ob's WHERE (ob ⊆ c). Per candidate id, first an index-only count of ALL
-- its holders (a parcel held once at all is never shared — no filter can raise a
-- count), then, only past that gate, the exact count the old GROUP BY … HAVING made:
-- every non-disposition, non-test holder of the WHOLE history. CASE fixes that order.
sh0 AS MATERIALIZED (
  SELECT DISTINCT c.mex_tracking_id AS tr
  FROM public.orders c
  WHERE c.mex_tracking_id IS NOT NULL
    AND (c.sold_at BETWEEN $1 AND $2
         OR (c.sold_at IS NULL AND c.confirmed_at BETWEEN $1 AND $2)
         OR c.created_at BETWEEN $1 AND $2
         OR c.id = ANY (ARRAY(SELECT led.order_id FROM led WHERE led.decided_at BETWEEN $1 AND $2)))
    AND c.mex_tracking_id NOT IN (SELECT wc.tr FROM wc)
    AND c.mex_tracking_id NOT IN (SELECT tp.tr FROM tp)
    AND CASE WHEN (SELECT count(*) FROM public.orders h WHERE h.mex_tracking_id = c.mex_tracking_id) > 1
             THEN (SELECT count(*) FROM public.orders x
                    WHERE x.mex_tracking_id = c.mex_tracking_id
                      AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                      AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $4)) > 1
             ELSE false END
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
    -- 10 Skopje days after the sale day (owner 03.10.2026, 20260947001850): a sale MEX never took
    -- counts no more — no parcel at all (to pack; 'shipped' in the CRM with no MEX parcel) or a
    -- parcel still at MEX 8 (label created, never picked up). Counting only: the order and its
    -- status are untouched, and a parcel that comes later brings the sale back on its own day.
    -- A parcel MEX holds (1 / 4 / 10 / 3 / 9 / 13) counts until MEX says paid / returned; a
    -- return stays a return; paid with no parcel (legacy / unproven) is not this rule's.
    AND NOT (ob.sale_at < $5
             AND (ob.bucket IN ('to_pack', 'label') OR (ob.bucket = 'courier' AND NOT ob.hp)))
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
-- social · 10114 LEADS-OUT) — and, since 20260947001850 (owner 03.10.2026: every sale
-- shows at once, in collabBox or not), a 10111 LEADS document still waiting for a holder
-- (credit_pending) whose customer's phone we know and that is not the copy of a living
-- Тим Маџари In sale (bk) — booked on a sale day at most 10 Skopje days back
-- (cohort_unshipped_since; it was doc_at ≥ now() − 14 days, the writer's own wait) — and never a document an order holds or names, one
-- whose parcel an ORDER holds (that order counts), one a web order claims, or a
-- komitent the writer skips (deceased, employee, …). p8 = the customer's
-- phone as the writer finds it: the komitent card → the teleshop registry →
-- any stored card.
-- name_key (collabbox_name_key, ~0,2 ms a call) is read only by bk's phoneless twin rule
-- (k.p8 IS NULL): computed for those bookings alone (20260947001500).
bk0 AS MATERIALIZED (
  SELECT d.doc_number, d.doc_type_id, d.doc_at, d.sale_at, d.amount_mkd, d.goods_mkd, d.author_person_id,
         CASE WHEN d.p8 IS NULL THEN public.collabbox_name_key(d.komitent_name) END AS name_key,   -- the phoneless twin (20260944000630)
         d.dep, d.p8
  FROM (
  SELECT b.doc_number, b.doc_type_id, b.doc_at, public.collabbox_sale_at(b.doc_at, b.booked_at) AS sale_at,
         b.amount_mkd, b.goods_mkd, b.author_person_id, b.komitent_name,
         public.collabbox_department(b.doc_type_id, b.doc_number, b.author_person_id, b.doc_at) AS dep,
         coalesce(
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.source = 'card' AND c.phone8 ~ '^[0-9]{8}$'),
           (SELECT t.phone8 FROM public.teleshop_import_customers t
             WHERE t.komitent_id = b.komitent_id AND t.phone8 ~ '^[0-9]{8}$'),
           (SELECT c.phone8 FROM public.collabbox_customers c
             WHERE c.komitent_id = b.komitent_id AND c.phone8 ~ '^[0-9]{8}$')) AS p8
  FROM public.collabbox_documents b
  WHERE b.doc_at >= $5                                   -- the index; the sale day is never after doc_at
    AND public.collabbox_sale_at(b.doc_at, b.booked_at) >= $5
    AND (   (b.doc_type_id IN ('10036', '10050', '10106', '10055', '10114')
             AND b.outcome IN ('booked', 'awaiting_parcel'))
         OR (b.doc_type_id = '10111'                     -- LEADS: only until MEX has its parcel — then
             AND b.outcome IN ('booked', 'credit_pending')   -- the parcel counts (MEX-only on this booking
             AND NOT EXISTS (SELECT 1 FROM public.mex_parcels p   -- day, mo) until an order holds it: its
                              WHERE p.tracking_id = b.doc_number)))   -- MEX status, not "to pack", for days
    AND b.vanished_at IS NULL
    AND NOT b.is_storno
    AND b.reversed_by IS NULL
    AND b.amount_mkd > 0
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
  OFFSET 0                 -- p8 computed once per document, never re-expanded into the CASE
  ) d
  -- a LEADS booking counts only with the customer's phone (bk, 20260947001850): without one it
  -- waits for its parcel, and never reaches bk's probes
  WHERE d.doc_type_id <> '10111' OR d.p8 IS NOT NULL
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
    -- a gate, not a join filter (20260947001500): the probe below runs only for a booking
    -- with no phone (was: for every booking, k.p8 IS NULL checked after the index probe)
    AND (k.p8 IS NOT NULL OR NOT EXISTS (
      SELECT 1 FROM public.orders x
       WHERE x.sold_by_person_id = k.author_person_id
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
              OR abs(round(x.price * 61.5) - round(coalesce(k.goods_mkd, k.amount_mkd))) <= 3)))
    -- 10111 LEADS (owner 03.10.2026, 20260947001850): the booking of an AlterCPA lead counts at
    -- once (Во магацин, Тим Маџари In, its author, its booking day) — a lead the operator cancelled /
    -- trashed in AlterCPA and booked anyway is a sale the moment it is booked. Never when it is the
    -- collabBox COPY of a living Тим Маџари In sale that already counts (an AlterCPA approval with no
    -- parcel of its own): on the customer's phone, its sale or decision 30 days before … 1 day after
    -- the booking, amount ignored (up-sells — leads_parcel_orders_plan's "a living Affiliate sale on
    -- the phone"). Only with the customer's phone (bk0 drops a LEADS booking without one): without it
    -- a booking cannot be told from the copy of an approval — backtest 19–30.09: the author + folded
    -- name rule still double-counted 208 of 677 phoneless bookings (collabBox names are mostly a
    -- first name alone; the operators approve 2–24 h before booking, other leads in between) — so it
    -- waits for its parcel, as before. The writer's twin rule above applies to LEADS too.
    AND (k.doc_type_id <> '10111' OR (
          k.p8 IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM public.orders x
             WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = k.p8
               AND x.sale_source = 'altercpa'
               AND x.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
               AND x.mex_tracking_id IS NULL
               AND x.price > 0
               AND NOT public.is_synthetic_product_name(x.product_name)
               AND x.sale_source_detail IS DISTINCT FROM 'disposition'
               -- it still counts: not a sale MEX never took 10 days on (o above; the cohort's own sale
               -- moment — an unstamped approval is dated by its AlterCPA decision, like led)
               AND NOT (x.status::text IN ('confirmed', 'shipped')
                        AND coalesce(x.sold_at,
                                     (SELECT max(l.decided_at) FROM public.altercpa_leads l
                                       WHERE l.order_id = x.id AND l.decision IN ('approved', 'cancel_other')),
                                     x.confirmed_at, x.created_at) < $5)
               AND (coalesce(x.sold_at, x.confirmed_at, x.created_at)
                      BETWEEN k.sale_at - interval '30 days' AND k.sale_at + interval '1 day'
                    OR EXISTS (SELECT 1 FROM public.altercpa_leads l
                                WHERE l.order_id = x.id
                                  AND l.decided_at BETWEEN k.sale_at - interval '30 days' AND k.sale_at + interval '1 day')))))
),
mo AS MATERIALIZED (       -- MEX-only: no live web order, no real order holds it
  -- (a parcel a TEST order holds is that order's: counted nowhere either)
  -- Its day (20260947001850, owner 03.10.2026 — one sale, one day): the day its collabBox
  -- document was BOOKED (collabbox_sale_at; the booking day is the law for the whole ledger since
  -- 20260944000620, collabbox_booking_day_since() = 01.03.2026), else — or when MEX created it
  -- first — the day MEX created it. So a booking whose parcel no order holds yet stays
  -- on its day when it leaves the bookings (bk's 10 days) — never dropped while MEX holds it.
  SELECT p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.created_at_mex,
         p.delivered_at, p.receiver_city, p.phone8,
         public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference) AS split,
         least(bd.sale_at, p.created_at_mex) AS sale_at   -- a document booked after the parcel existed is not its booking
  FROM (
    SELECT p1.tracking_id, p1.account, p1.series, p1.status_id, p1.cod_mkd, p1.created_at_mex, p1.delivered_at,
           p1.receiver_city, p1.phone8, p1.sender_reference, p1.order_id
    FROM public.mex_parcels p1
    WHERE p1.created_at_mex BETWEEN $1 AND $2
    UNION ALL
    -- a parcel MEX created after the window whose document was booked inside it (a booking is
    -- never more than 31 days before its document's date — collabbox_estimate_booked_at)
    SELECT p2.tracking_id, p2.account, p2.series, p2.status_id, p2.cod_mkd, p2.created_at_mex, p2.delivered_at,
           p2.receiver_city, p2.phone8, p2.sender_reference, p2.order_id
    FROM public.mex_parcels p2
    WHERE p2.created_at_mex > $2 AND p2.created_at_mex <= $2 + interval '31 days'
      AND EXISTS (SELECT 1 FROM public.collabbox_documents b
                   WHERE b.doc_number = p2.tracking_id
                     AND public.collabbox_sale_at(b.doc_at, b.booked_at) BETWEEN $1 AND $2)
  ) p
  LEFT JOIN LATERAL (
    SELECT public.collabbox_sale_at(b.doc_at, b.booked_at) AS sale_at
    FROM public.collabbox_documents b
    WHERE b.doc_number = p.tracking_id
      AND b.doc_type_id IN ('10036', '10050', '10106', '10055', '10111', '10114')
      AND b.vanished_at IS NULL AND NOT b.is_storno AND b.reversed_by IS NULL AND b.amount_mkd > 0
      AND public.collabbox_sale_at(b.doc_at, b.booked_at) >= public.collabbox_booking_day_since()) bd ON true
  WHERE least(bd.sale_at, p.created_at_mex) BETWEEN $1 AND $2
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
-- One probe of idx_orders_phone_last8 per MEX-only parcel with a COD — the phone
-- expression is character-for-character the index's (20260947001500; was a
-- sequential scan of every order, ~300 ms, hashed against a few dozen parcels).
-- A scalar sub-select, so it stays a per-parcel probe whatever the estimates.
dbl AS MATERIALIZED (
  SELECT mo.tracking_id
  FROM mo
  WHERE coalesce(mo.cod_mkd, 0) > 0
    AND coalesce((
      SELECT true
      FROM public.orders x
      WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = mo.phone8
        AND x.mex_tracking_id IS NULL
        AND x.status IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
        AND coalesce(x.price, 0) > 0
        AND x.sale_source_detail IS DISTINCT FROM 'disposition'
        AND x.customer_phone IS NOT NULL
        AND coalesce(x.sold_at, x.confirmed_at, x.created_at)
            BETWEEN $1 - interval '21 days' AND $2 + interval '21 days'
        AND coalesce(x.sold_at, x.confirmed_at, x.created_at)
            BETWEEN mo.created_at_mex - interval '21 days' AND mo.created_at_mex + interval '21 days'
      LIMIT 1), false)
),
mr AS (
  SELECT 'mex'::text AS kind,
         public.cohort_parcel_source(mo.split) AS source, -- a parcel with no order: the source its series names
         mo.split,
         NULL::text AS sale_source,
         mo.sale_at,                                   -- its booking day, else the day MEX created it
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
  -- (c) a label MEX created and never picked up, 10 Skopje days after the sale (o above)
  WHERE NOT (mo.sale_at < $5 AND public.cohort_parcel_bucket(mo.status_id, mo.cod_mkd) = 'label')
),
bkr AS (
  SELECT 'booking'::text AS kind,
         -- the folder's department: the twin of the order the document becomes
         coalesce(public.order_dept_by_team(bk.dep[1], bk.author_person_id, bk.sale_at), public.cohort_order_source(bk.dep[1], bk.dep[2], bk.doc_number)) AS source,   -- the author's team first (20260947000400)
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
  v_since    timestamptz;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL THEN
    RAISE EXCEPTION 'insights_sale_rows: p_from and p_to_end are required' USING ERRCODE = '22023';
  END IF;
  IF p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_sale_rows: bad window' USING ERRCODE = '22023';
  END IF;

  -- the test phones: read once, a constant for the planner
  v_excluded := public.report_excluded_phone8s();
  v_since    := public.cohort_unshipped_since();
  IF coalesce(p_keys, true) THEN
    RETURN QUERY EXECUTE v_rows || v_keys USING p_from, p_to_end, true, v_excluded, v_since;
  ELSE
    RETURN QUERY EXECUTE v_rows || v_plain USING p_from, p_to_end, false, v_excluded, v_since;
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.insights_cohort_order_exceptions(p_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_to_end timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  WITH xp AS MATERIALIZED (   -- the shared test-phone list, read once
    SELECT public.report_excluded_phone8s() AS l
  ),
  led AS (
    SELECT l.order_id, max(l.decided_at) AS decided_at
    FROM public.altercpa_leads l
    JOIN public.orders x ON x.id = l.order_id AND x.sold_at IS NULL
    WHERE l.order_id IS NOT NULL
      AND l.decision IN ('approved', 'cancel_other')
      AND l.decided_at IS NOT NULL
    GROUP BY l.order_id
  )
  SELECT jsonb_build_object(
    'web_claimed', coalesce((
      SELECT jsonb_agg(DISTINCT x.id)
      FROM public.orders x
      JOIN public.web_orders w ON w.mex_tracking_id = x.mex_tracking_id AND w.deleted_in_shop_at IS NULL
      WHERE x.mex_tracking_id IS NOT NULL), '[]'::jsonb),
    'ledger', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', q.order_id, 'sale_at', q.decided_at) ORDER BY q.order_id)
      FROM led q
      JOIN public.orders x ON x.id = q.order_id
      WHERE p_from IS NULL OR p_to_end IS NULL
         OR q.decided_at BETWEEN p_from AND p_to_end
         OR coalesce(x.confirmed_at, x.created_at) BETWEEN p_from AND p_to_end), '[]'::jsonb),
    'excluded_phone8s', (SELECT to_jsonb(xp.l) FROM xp),
    -- 20260947001850: insights_sale_rows' $5 — a sale before it that MEX never took (no parcel,
    -- or still at MEX 8) is in no bucket; the /orders twin (insightsCommon.ts) reads it from here
    'expire_before', public.cohort_unshipped_since(),
    'test_orders', coalesce((
      SELECT jsonb_agg(x.id ORDER BY x.id)
      FROM public.orders x
      -- the scalar sub-selects run once (InitPlans); the phone one is
      -- idx_orders_phone_last8's expression, so it is an index probe
      WHERE (public.insights_phone8(x.customer_phone) = ANY ((SELECT xp.l FROM xp)::text[])
             OR x.mex_tracking_id IN (SELECT p.tracking_id FROM public.mex_parcels p
                                       WHERE p.phone8 = ANY ((SELECT xp.l FROM xp)::text[])))
        AND NOT EXISTS (SELECT 1 FROM xp, unnest(xp.l) t(p8)
                         WHERE x.customer_phone LIKE '%' || t.p8)), '[]'::jsonb))
$function$;

-- Pure Profit's monthly cache (insights_profit_monthly) holds closed months of the cohort clock. This
-- changes closed months (labels never picked up since April, MEX-only parcels on their booking day) and
-- moves no row's updated_at: a new version makes insights_profit_refresh_nightly (03:40 Skopje) rebuild
-- every month; until then insights_profit_cache_read serves none of them (the api computes them live).
CREATE OR REPLACE FUNCTION public.insights_profit_cache_version()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 8 $function$;
