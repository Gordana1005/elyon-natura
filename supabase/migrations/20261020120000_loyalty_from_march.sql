-- ============================================================================
-- Лојалност — points count from 01.03.2026, not 01.01.2026 (owner 20.10.2026:
-- "мора да се сметат од 01. Март").
--
-- Only the start of the window moves: sale day (Skopje) from 2026-03-01 through
-- today. Every other rule of 20261006120000 is unchanged (MEX 2 + paid, Teleshop
-- Out, NaturaTherapy lines × 61.5 per shipment, the 65 / 100 / 150 / 200 / 350
-- ladder). 01.03.2026 00:00 Skopje (CET) = 2026-02-28 23:00 UTC.
--
-- The catch-up below removes the January–February grants (measured 20.10:
-- 5.415 shipments, 1.207.345 points; 1.732 customers had only those) and the
-- shop badges of phones that no longer hold any grant (39).
--
-- Rollback: re-apply loyalty_sure_centar_out() from 20261006120000, then
--           SELECT public.loyalty_catchup(); and re-run scripts/loyalty-mark-shop.mjs.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.loyalty_sure_centar_out()
RETURNS TABLE (
  order_id uuid,
  display_id text,
  phone8 text,
  sale_day date,
  mex_tracking_id text,
  nt_mkd integer,
  points integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH win AS MATERIALIZED (
    SELECT o.id,
           nullif(btrim(o.display_id), '') AS display_id,
           btrim(o.mex_tracking_id) AS mex_tracking_id,
           right(regexp_replace(coalesce(o.customer_phone, ''), '\D', '', 'g'), 8) AS phone8,
           (coalesce(o.sold_at, o.confirmed_at, o.created_at) AT TIME ZONE 'Europe/Skopje')::date AS sale_day
      FROM public.orders o
     WHERE coalesce(o.sold_at, o.confirmed_at, o.created_at) >= TIMESTAMPTZ '2026-02-28 22:00:00+00'
       AND o.mex_status_id = 2
       AND o.status = 'paid'
       AND btrim(coalesce(o.mex_tracking_id, '')) <> ''
       AND NOT public.is_report_excluded_phone(o.customer_phone)
       AND public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) = 'teleshop_out'
  ),
  scoped AS MATERIALIZED (
    SELECT * FROM win
     WHERE sale_day >= DATE '2026-03-01'
       AND sale_day <= (now() AT TIME ZONE 'Europe/Skopje')::date
  ),
  name_map AS MATERIALIZED (
    SELECT public.loyalty_name_key(p.name) AS k,
           min(p.brand_line) AS brand_line
      FROM public.products p
     WHERE p.brand_line IS NOT NULL
       AND public.loyalty_name_key(p.name) <> ''
     GROUP BY 1
    HAVING count(DISTINCT p.brand_line) = 1
  ),
  lines AS MATERIALIZED (
    SELECT s.id,
           coalesce(oi.total_price, 0) AS eur,
           coalesce(p.kind, '') AS kind,
           CASE
             WHEN coalesce(p.brand_line, '') <> '' THEN p.brand_line
             WHEN nm.brand_line IS NOT NULL THEN nm.brand_line
             ELSE ''
           END AS brand_line
      FROM scoped s
      JOIN public.order_items oi ON oi.order_id = s.id
      LEFT JOIN public.products p ON p.id = oi.product_id
      LEFT JOIN name_map nm
        ON nm.k = public.loyalty_name_key(coalesce(nullif(oi.product_name, ''), p.name, ''))
  ),
  per AS MATERIALIZED (
    SELECT s.id, s.display_id, s.phone8, s.mex_tracking_id, s.sale_day,
           coalesce(round(sum(l.eur) FILTER (
             WHERE l.brand_line = 'natura_therapy' AND l.kind IS DISTINCT FROM 'gift'
           ) * 61.5), 0)::int AS nt_mkd
      FROM scoped s
      LEFT JOIN lines l ON l.id = s.id
     GROUP BY s.id, s.display_id, s.phone8, s.mex_tracking_id, s.sale_day
  )
  SELECT p.id, p.display_id, p.phone8, p.sale_day, p.mex_tracking_id, p.nt_mkd,
         CASE
           WHEN p.nt_mkd >= 2400 THEN 350
           WHEN p.nt_mkd >= 2000 THEN 200
           WHEN p.nt_mkd >= 1800 THEN 150
           WHEN p.nt_mkd >= 1200 THEN 100
           WHEN p.nt_mkd >= 600 THEN 65
           ELSE 0
         END AS points
    FROM per p
   WHERE p.nt_mkd >= 600
     AND p.phone8 ~ '^[0-9]{8}$';
$$;

REVOKE ALL ON FUNCTION public.loyalty_sure_centar_out() FROM PUBLIC, anon, authenticated;

SELECT public.loyalty_catchup();

-- A badge marks a phone that holds a grant AND a shop profile; a phone left with
-- no grant loses its badge.
DELETE FROM public.loyalty_shop_phone s
 WHERE NOT EXISTS (SELECT 1 FROM public.loyalty_grants g WHERE g.phone8 = s.phone8);

DO $$
DECLARE
  v_old integer;
  v_orders integer;
BEGIN
  SELECT count(*) FILTER (WHERE sale_day < DATE '2026-03-01'), count(*)
    INTO v_old, v_orders
    FROM public.loyalty_grants;
  IF v_old > 0 THEN
    RAISE EXCEPTION 'loyalty grants before 01.03.2026 left: %', v_old;
  END IF;
  IF v_orders < 15000 THEN
    RAISE EXCEPTION 'loyalty grants from March unexpectedly low: %', v_orders;
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
