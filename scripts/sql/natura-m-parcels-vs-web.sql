-- READ-ONLY (run with read_only: true). HANDOFF 2026-09-28 §4.5: "check whether the 3.176
-- NATURA 'M…' parcels with COD 0 are card-paid web orders (compare to web_orders by
-- phone/date/payment)". A card-paid web order is collected by the shop, so MEX carries it
-- with COD 0 — if these parcels are that, they are web money already counted by the shop
-- mirror and must stay OUT of MEX-only (Teleshop/Other) figures.
--
-- Part 1: what the M-prefix parcels are.
SELECT count(*)                                              AS m_parcels,
       count(*) FILTER (WHERE coalesce(p.cod_mkd, 0) = 0)    AS cod_0,
       count(*) FILTER (WHERE p.cod_mkd > 0)                 AS cod_positive,
       count(*) FILTER (WHERE p.order_id IS NOT NULL)        AS linked_to_crm_order,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.web_orders w
                                       WHERE w.mex_tracking_id = p.tracking_id)) AS claimed_by_web,
       count(*) FILTER (WHERE p.sender_reference ILIKE 'NTMK%') AS ntmk_reference,
       count(*) FILTER (WHERE p.status_id = 2)               AS delivered,
       min(p.created_at_mex)                                 AS first_created,
       max(p.created_at_mex)                                 AS last_created
  FROM public.mex_parcels p
 WHERE p.account = 'natura' AND p.tracking_id ~ '^M';

-- Part 2: COD-0 M parcels matched to a web order on the same phone, the web order placed
-- from 10 days before to 1 day after the parcel was created (nearest one wins).
WITH m AS (
  SELECT p.tracking_id, p.phone8, p.created_at_mex, p.status_id
    FROM public.mex_parcels p
   WHERE p.account = 'natura' AND p.tracking_id ~ '^M' AND coalesce(p.cod_mkd, 0) = 0
     AND p.order_id IS NULL AND p.phone8 IS NOT NULL
), j AS (
  SELECT m.tracking_id, w.shop_order_id, w.payment_method, w.payment_status, w.status AS shop_status,
         w.total, w.mex_tracking_id AS web_claims,
         row_number() OVER (PARTITION BY m.tracking_id
                            ORDER BY abs(extract(epoch FROM (m.created_at_mex - w.created_at)))) AS rn
    FROM m
    JOIN public.web_orders w
      ON w.phone8 = m.phone8
     AND w.deleted_in_shop_at IS NULL
     AND m.created_at_mex BETWEEN w.created_at - interval '1 day' AND w.created_at + interval '10 days'
)
SELECT coalesce(j.payment_method, '(no web order on the phone)') AS payment_method,
       coalesce(j.payment_status, '—')                            AS payment_status,
       count(*)                                                   AS parcels,
       count(*) FILTER (WHERE j.web_claims IS NULL)               AS web_order_has_no_parcel_link,
       count(*) FILTER (WHERE j.web_claims IS NOT NULL AND j.web_claims <> m.tracking_id)
                                                                  AS web_order_claims_another_parcel,
       round(sum(j.total))                                        AS web_total_mkd
  FROM m
  LEFT JOIN j ON j.tracking_id = m.tracking_id AND j.rn = 1
 GROUP BY 1, 2
 ORDER BY 3 DESC;
-- Reading: CARD/PAID matches with web_order_has_no_parcel_link = the shop's card orders whose
-- parcel was never linked (link them in web-sync's matcher, not by hand); '(no web order on
-- the phone)' = not web — report the count to the owner as still unexplained.
