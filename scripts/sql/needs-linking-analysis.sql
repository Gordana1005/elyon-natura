-- READ-ONLY (run with read_only: true). HANDOFF 2026-09-28 §4.5:
-- "look deeper in MEX for the 47 needs_linking orders and link only what's provable".
--
-- The 7-day no-parcel rule (20260938000000) never cancels an order that has an UNLINKED
-- parcel on the same phone (created from 2 days before the sale): it files it as
-- `needs_linking`. For every such order of the LATEST run this lists every free parcel on
-- the phone and the evidence. A row is `provable` only when ALL hold:
--   · the parcel is BIO NATURAL series 9110 (the AlterCPA/LEADS series — the rule's scope is
--     AlterCPA/affiliate sales);
--   · its COD fits the CRM price (round(price × 61.5) ±3 ден, or that +150 delivery ±3);
--   · it was created within [sale − 2 d, sale + 21 d];
--   · it is the ONLY strong parcel for this order, and no OTHER open sale on the phone could
--     own it (1:1 both ways).
-- Before linking, still eyeball receiver_name / receiver_city against the order (Latin vs
-- Cyrillic spellings differ; a different person on the same phone is not this sale).
--
-- Link a provable row (NOT read-only; tripwire first; one statement per order):
--   SELECT public.mex_link_parcel('<tracking_id>', '<order uuid>'::uuid, 'repair');   -- → 'linked'
--   INSERT INTO public.order_notes (order_id, text, author_name)
--   VALUES ('<order uuid>'::uuid, 'MEX parcel <tracking_id> linked by hand: same phone, COD fits, '
--           || 'series 9110, only candidate (7-day rule needs_linking, owner 28.09)', 'System (repair)');
-- mex_link_parcel copies the parcel's facts onto the order; the next mex-reconcile run
-- (:07/:37, 07:00–20:55 Skopje) moves the confirmed order to its MEX status.
WITH last_run AS (
  SELECT id, run_day, mode, ran_at FROM public.no_parcel_rule_runs ORDER BY ran_at DESC LIMIT 1
), nl AS (
  SELECT i.order_id, i.parcel_tracking
    FROM public.no_parcel_rule_items i JOIN last_run r ON r.id = i.run_id
   WHERE i.action = 'needs_linking'
), o AS (
  SELECT o.id, o.display_id, o.status::text AS status, o.sale_source, o.price,
         round(o.price * 61.5)::int AS price_mkd,
         coalesce(o.sold_at, o.confirmed_at, o.created_at) AS sale_at,
         o.customer_name, o.customer_city,
         right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 8) AS phone8,
         o.mex_tracking_id, nl.parcel_tracking AS rule_parcel
    FROM nl JOIN public.orders o ON o.id = nl.order_id
), cand AS (
  -- every FREE parcel on the phone from 2 days before the sale (not only the one the rule saw)
  SELECT o.id AS order_id, p.tracking_id, p.account, p.series, p.status_id, p.status_name,
         p.cod_mkd, p.receiver_name, p.receiver_city, p.created_at_mex,
         (abs(coalesce(p.cod_mkd, -99999) - o.price_mkd) <= 3
          OR abs(coalesce(p.cod_mkd, -99999) - o.price_mkd - 150) <= 3)        AS cod_fit,
         p.created_at_mex <= o.sale_at + interval '21 days'                     AS window_ok,
         (p.account = 'bio_natural' AND p.series = '9110')                      AS leads_series
    FROM o
    JOIN public.mex_parcels p ON p.phone8 = o.phone8
   WHERE p.order_id IS NULL
     AND p.created_at_mex >= o.sale_at - interval '2 days'
     AND NOT EXISTS (SELECT 1 FROM public.orders h     WHERE h.mex_tracking_id = p.tracking_id)
     AND NOT EXISTS (SELECT 1 FROM public.web_orders w WHERE w.mex_tracking_id = p.tracking_id)
), per_order AS (
  SELECT order_id, count(*) AS free_parcels,
         count(*) FILTER (WHERE cod_fit AND window_ok AND leads_series) AS strong
    FROM cand GROUP BY order_id
), other_open AS (
  -- other unshipped sales on the same phone that could own the same parcel
  SELECT o.id AS order_id, count(x.id) AS n
    FROM o
    LEFT JOIN public.orders x
      ON right(regexp_replace(coalesce(x.customer_phone, ''), '\D', '', 'g'), 8) = o.phone8
     AND x.id <> o.id AND x.mex_tracking_id IS NULL AND coalesce(x.price, 0) > 0
     AND x.status::text IN ('pending', 'take', 'call_again', 'confirmed')
   GROUP BY o.id
)
SELECT (SELECT run_day FROM last_run) AS run_day, (SELECT mode FROM last_run) AS mode,
       o.display_id, o.id AS order_id, o.status, o.sale_source, o.sale_at, o.price_mkd,
       o.customer_name, o.customer_city, o.rule_parcel,
       c.tracking_id, c.account, c.series, c.status_id, c.status_name, c.cod_mkd,
       c.receiver_name, c.receiver_city, c.created_at_mex,
       c.cod_fit, c.window_ok, c.leads_series,
       coalesce(po.free_parcels, 0) AS free_parcels, coalesce(po.strong, 0) AS strong,
       coalesce(oo.n, 0) AS other_open_sales,
       coalesce(c.cod_fit AND c.window_ok AND c.leads_series
                AND po.strong = 1 AND coalesce(oo.n, 0) = 0, false) AS provable
  FROM o
  LEFT JOIN cand c        ON c.order_id = o.id
  LEFT JOIN per_order po  ON po.order_id = o.id
  LEFT JOIN other_open oo ON oo.order_id = o.id
 ORDER BY provable DESC, o.sale_at, c.created_at_mex;
