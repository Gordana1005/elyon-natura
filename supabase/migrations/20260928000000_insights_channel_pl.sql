-- ============================================================================
-- CHANNEL P&L + PER-AFFILIATE (WEBMASTER) BREAKDOWN — MACEDONIA (2026-08-19)
--
-- Ported from Bulgaria's 20260919000000_insights_channel_pl.sql + its
-- 20260928000000 follow-up (per-affiliate sold/sold_revenue), but NOT a copy —
-- the affiliate world here is structurally different and a literal port would
-- have rendered a permanently blank screen (the same trap 20260922000000
-- documents for the rate guarantee):
--
--   BG: own affiliate system — affiliate_leads sidecar carries a
--       payout_eur_snapshot per lead, affiliates table holds the partner.
--   MK: affiliate_leads is EMPTY (0 rows). Every affiliate lead arrives
--       through the AlterCPA bridge; attribution lives ON the order
--       (orders.cpa_webmaster_id / cpa_offer_id, 20260927000100) and the
--       partner registry is altercpa_webmasters.
--
-- ── LEAD COST IS DELIBERATELY 0 — THE SLOT IS WIRED, THE NUMBER IS PENDING ──
-- Nothing in this database knows what we pay per lead: AlterCPA's payload has
-- no payout field and no rate card has been supplied. The operator will
-- provide per-webmaster lead prices later (his words, 2026-08-19). Every
-- lead_cost_* column below is therefore emitted as a literal 0 so the whole
-- response shape — RPC → edge fn → ChannelPLCard/AffiliateBreakdownCard —
-- matches Bulgaria's and NOTHING downstream changes when the rates arrive.
-- When they do: add a rates table (e.g. cpa_webmaster_rates(wm_id, payout_eur))
-- and replace the `0::float8 AS payout` line in `base` with the joined rate.
-- That is the ONLY edit this design requires.
--
-- ── THE FOUR RULES INHERITED FROM 20260911000000 ───────────────────────────
--   1. NOTHING IS ROUNDED HERE. Raw values out; TS rounds once, at the end.
--   2. Money is float8, never numeric.
--   3. The rate card is NOT read here. Logistics comes back as delivered/
--      returned COUNTS per courier+service and TS applies loadCourierRates().
--   4. normAgent() is NEVER ported. Agents come back at RAW owner grain.
--
-- MEX: unlike the older rollups (which predate 20260915000400), the courier
-- CASE here knows mex_office and home_courier='mex' — matching the TS
-- resolveCourierService exactly. 200 orders carry it already and it is the
-- only courier offered for new orders.
--
-- SET TimeZone='UTC' is load-bearing: it pins 'YYYY-MM-DD' bounds to UTC
-- midnight exactly as PostgREST does.
--
-- Read-side only. No writes, no schema changes.
-- ============================================================================


-- ── 1. order_channel — the canonical origin classifier ─────────────────────
-- Priority is deliberate: affiliate FIRST — that bucket is (or will be) money
-- we OWE and must never be shadowed by an attribution added later.
--
-- p_is_affiliate here means "arrived through the AlterCPA bridge":
-- cpa_webmaster_id IS NOT NULL OR external_source = 'altercpa'. Both signals
-- are OR'd for the same reason BG unions sidecar+source_type: if either is
-- present the order is partner traffic.
--
-- 'inbound' is kept in the vocabulary even though this market has no own-site
-- webhook yet — the four-bucket shape is what the shared frontend expects, and
-- a future naturatherapy.mk funnel lands there without another migration.
CREATE OR REPLACE FUNCTION public.order_channel(
  p_source_type        text,
  p_prediction_list_id uuid,
  p_is_affiliate       boolean
) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN coalesce(p_is_affiliate, false) OR p_source_type = 'affiliate'
      THEN 'affiliate'
    WHEN p_prediction_list_id IS NOT NULL OR p_source_type = 'prediction_lead'
      THEN 'prediction'
    WHEN p_source_type IN ('inbound_lead','opencart','opencart_abandoned')
      THEN 'inbound'
    ELSE 'manual'   -- NULL source_type and any value added later land here
  END
$$;
COMMENT ON FUNCTION public.order_channel(text, uuid, boolean) IS
  'Canonical order channel for P&L: affiliate > prediction > inbound > manual. MK: affiliate = arrived via the AlterCPA bridge.';


-- ── 2. insights_channel_pl — per-channel and per-webmaster raw counters ────
-- Called UNCONDITIONALLY by GET /management-insights, under both engines, so
-- the channel numbers are identical by construction whichever engine renders
-- the blended figures.
--
-- Cohort = orders CREATED in range, the same window every other Insights
-- figure uses. (BG's accrual block windows on confirmed_at for partner
-- invoicing; with zero payout there is nothing to invoice, so accrual is
-- emitted as zeros to keep the shape.)
CREATE OR REPLACE FUNCTION public.insights_channel_pl(p_from text, p_to_end text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $$
WITH base AS (
  -- The insights_orders_rollup base filter verbatim, plus the CPA attribution
  -- and the channel. Project only what is needed: `g` is referenced by ~8 CTEs
  -- and will materialise.
  SELECT o.id, o.status::text AS status, o.price, o.quantity, o.product_name,
         o.delivery_type, o.home_courier,
         o.assigned_agent_name, o.confirmed_by_name,
         o.source_type, o.created_at, o.prediction_list_id,
         (o.cpa_webmaster_id IS NOT NULL
            OR o.external_source = 'altercpa')          AS is_affiliate,
         o.cpa_webmaster_id                             AS affiliate_id,
         -- THE LEAD-COST SLOT. 0 until the operator supplies per-webmaster
         -- rates; see the header. Kept in the row shape so every downstream
         -- sum works unchanged the day it becomes real.
         0::float8                                      AS payout,
         public.order_channel(o.source_type, o.prediction_list_id,
                              (o.cpa_webmaster_id IS NOT NULL
                                 OR o.external_source = 'altercpa')) AS channel
  FROM public.orders o
  WHERE (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND (nullif(p_from, '')   IS NULL OR o.created_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to_end, '') IS NULL OR o.created_at <= nullif(p_to_end, '')::timestamptz)
),
it AS (
  SELECT i.order_id,
         count(*)::int                     AS n_items,
         coalesce(sum(i.quantity), 0)::int AS q_sum,
         -- orderPackageBonus items branch: packageBonusRate(price_per_unit) * quantity
         coalesce(sum(
           (CASE WHEN coalesce(i.price_per_unit, 0) >= 35 THEN 3
                 WHEN coalesce(i.price_per_unit, 0) >  25 THEN 2
                 ELSE 1 END) * coalesce(i.quantity, 0)), 0)::int AS bonus_items
  FROM public.order_items i JOIN base b ON b.id = i.order_id
  GROUP BY i.order_id
),
g AS (
  SELECT b.*,
         (b.status IN ('confirmed','shipped','delivered','paid','returned')) AS is_real,
         (b.status IN ('confirmed','shipped','delivered','paid'))            AS is_sold,
         (b.status = 'paid')                                                 AS is_paid,
         -- unitsOf(): items.length ? Σqty : (num(quantity) || 1)
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
              WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END AS units,
         -- ownerOf() BEFORE normAgent. JS `??` skips null/undefined but NOT '',
         -- which is exactly what coalesce does.
         coalesce(b.confirmed_by_name, b.assigned_agent_name) AS owner_raw,
         -- resolveCourierService(): delivery_type wins over home_courier.
         -- MEX-aware — the TS twin gained mex in 20260915000400.
         CASE WHEN b.delivery_type = 'speedy_office' THEN 'speedy'
              WHEN b.delivery_type = 'econt_office'  THEN 'econt'
              WHEN b.delivery_type = 'mex_office'    THEN 'mex'
              WHEN b.home_courier IN ('speedy','econt','mex') THEN b.home_courier END AS courier,
         CASE WHEN b.delivery_type IN ('speedy_office','econt_office','mex_office') THEN 'office'
              WHEN b.home_courier IN ('speedy','econt','mex') THEN 'door' END          AS service,
         -- orderPackageBonus(). Legacy branch divides THEN compares, exactly as
         -- the TS does, so float behaviour matches.
         CASE WHEN b.status <> 'paid' THEN 0
              WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.bonus_items, 0)
              ELSE (CASE WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >  25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)
         END::int AS bonus
  FROM base b LEFT JOIN it t ON t.order_id = b.id
),

-- ── paid basis: the insights_paid_basis package chain, carrying channel ────
-- Package counting has a quirk that MUST be reproduced or Σ channels stops
-- tying to pure_profit.paid_packages: the items branch uses the RAW quantity
-- (a zero-quantity item contributes 0 packages) while the legacy branch uses
-- (quantity || 1) and is guarded on a non-empty product_name.
paid AS (
  SELECT g.id, g.price, g.quantity, g.product_name, g.channel, g.affiliate_id
  FROM g WHERE g.is_paid
),
pit AS (
  SELECT i.order_id, i.product_name, coalesce(i.quantity, 0) AS q,
         p.channel, p.affiliate_id
  FROM public.order_items i JOIN paid p ON p.id = i.order_id
),
pnit AS (SELECT order_id, count(*) AS n FROM pit GROUP BY 1),
plegacy AS (
  SELECT p.id AS order_id, p.product_name, p.channel, p.affiliate_id,
         (CASE WHEN coalesce(p.quantity, 0) = 0 THEN 1 ELSE p.quantity END) AS q
  FROM paid p LEFT JOIN pnit n ON n.order_id = p.id
  WHERE coalesce(n.n, 0) = 0 AND p.product_name IS NOT NULL AND p.product_name <> ''
),
all_lines AS (
  SELECT channel, affiliate_id, q FROM pit
  UNION ALL
  SELECT channel, affiliate_id, q FROM plegacy
),
pkg AS (SELECT channel, sum(q)::int AS paid_packages FROM all_lines GROUP BY 1),
pkg_aff AS (
  SELECT affiliate_id, sum(q)::int AS paid_packages
  FROM all_lines WHERE affiliate_id IS NOT NULL GROUP BY 1
),
-- orderCOGS() keys on the RAW product_name and uses (quantity || 1) — a
-- DIFFERENT key and a DIFFERENT unit count than the package chain above, and
-- with NO product_name guard on the legacy branch. Kept identical so
-- Σ channels ties to pure_profit.cogs exactly.
cogs_src AS (
  SELECT pit.channel, pit.affiliate_id, pit.product_name AS raw_product,
         CASE WHEN pit.q = 0 THEN 1 ELSE pit.q END AS u
  FROM pit
  UNION ALL
  SELECT p.channel, p.affiliate_id, p.product_name,
         CASE WHEN coalesce(p.quantity, 0) = 0 THEN 1 ELSE p.quantity END
  FROM paid p LEFT JOIN pnit n ON n.order_id = p.id WHERE coalesce(n.n, 0) = 0
),
cogs_units AS (
  SELECT channel, raw_product, sum(u)::int AS cogs_units
  FROM cogs_src GROUP BY 1, 2
),
cogs_units_aff AS (
  SELECT affiliate_id, raw_product, sum(u)::int AS cogs_units
  FROM cogs_src WHERE affiliate_id IS NOT NULL GROUP BY 1, 2
),

-- ── logistics: COUNTS only, rate card applied in TS ────────────────────────
logi AS (
  SELECT g.channel,
         coalesce(g.courier, 'unknown') AS courier,
         coalesce(g.service, '—')       AS service,
         (g.courier IS NOT NULL)        AS known,
         count(*) FILTER (WHERE g.status IN ('shipped','delivered','paid'))::int AS delivered,
         count(*) FILTER (WHERE g.status = 'returned')::int                      AS returned
  FROM g WHERE g.status IN ('shipped','delivered','paid','returned') GROUP BY 1,2,3,4
),
logi_aff AS (
  SELECT g.affiliate_id,
         coalesce(g.courier, 'unknown') AS courier,
         coalesce(g.service, '—')       AS service,
         (g.courier IS NOT NULL)        AS known,
         count(*) FILTER (WHERE g.status IN ('shipped','delivered','paid'))::int AS delivered,
         count(*) FILTER (WHERE g.status = 'returned')::int                      AS returned
  FROM g WHERE g.affiliate_id IS NOT NULL
    AND g.status IN ('shipped','delivered','paid','returned') GROUP BY 1,2,3,4
),

-- ── agents: RAW owner grain; TS applies agentNames.has(normAgent(...)) ONCE ─
ag AS (
  SELECT g.channel, g.owner_raw,
         coalesce(sum(g.bonus) FILTER (WHERE g.is_paid), 0)::int AS bonus_sum
  FROM g GROUP BY 1,2
),
ag_aff AS (
  SELECT g.affiliate_id, g.owner_raw,
         coalesce(sum(g.bonus) FILTER (WHERE g.is_paid), 0)::int AS bonus_sum
  FROM g WHERE g.affiliate_id IS NOT NULL GROUP BY 1,2
),

-- ── channel counters. Every lead_cost figure is a literal 0 (see header) ───
chan AS (
  SELECT g.channel,
    count(*)::int                                              AS orders,
    count(*) FILTER (WHERE g.is_real)::int                     AS real_orders,
    count(*) FILTER (WHERE g.is_sold)::int                     AS sold,
    count(*) FILTER (WHERE g.is_paid)::int                     AS paid_orders,
    count(*) FILTER (WHERE g.status = 'cancelled')::int        AS cancelled,
    count(*) FILTER (WHERE g.status = 'trashed')::int          AS trashed,
    count(*) FILTER (WHERE g.status = 'returned')::int         AS returned,
    count(*) FILTER (WHERE g.status = 'pending')::int          AS leads_pending,
    count(*) FILTER (WHERE g.status IN ('shipped','delivered','paid'))::int AS shipped_orders,
    coalesce(sum(g.price)  FILTER (WHERE g.is_paid), 0)::float8 AS cash_collected,
    coalesce(sum(g.price)  FILTER (WHERE g.is_sold), 0)::float8 AS sold_revenue,
    coalesce(sum(g.units)  FILTER (WHERE g.is_sold), 0)::int    AS units_sold,
    coalesce(sum(g.payout) FILTER (WHERE g.is_paid), 0)::float8 AS lead_cost_paid,
    0::int                                                      AS lead_cost_orders_paid,
    coalesce(sum(g.payout) FILTER (WHERE g.is_real), 0)::float8 AS lead_cost_earned,
    0::int                                                      AS lead_cost_orders_earned,
    0::float8                                                   AS lead_cost_open,
    0::float8                                                   AS lead_cost_dead,
    0::int                                                      AS lead_cost_orders_dead
  FROM g GROUP BY 1
),
aff AS (
  SELECT g.affiliate_id,
    count(*)::int                                              AS leads,
    count(*) FILTER (WHERE g.is_real)::int                     AS confirmed,
    count(*) FILTER (WHERE g.is_paid)::int                     AS paid,
    count(*) FILTER (WHERE g.status = 'cancelled')::int        AS cancelled,
    count(*) FILTER (WHERE g.status = 'trashed')::int          AS trashed,
    count(*) FILTER (WHERE g.status = 'returned')::int         AS returned,
    count(*) FILTER (WHERE g.status IN ('shipped','delivered','paid'))::int AS shipped_orders,
    count(*) FILTER (WHERE g.is_sold)::int                      AS sold,
    coalesce(sum(g.price)  FILTER (WHERE g.is_sold), 0)::float8 AS sold_revenue,
    coalesce(sum(g.price)  FILTER (WHERE g.is_paid), 0)::float8 AS cash_collected,
    coalesce(sum(g.payout) FILTER (WHERE g.is_paid), 0)::float8 AS lead_cost_paid,
    coalesce(sum(g.payout) FILTER (WHERE g.is_real), 0)::float8 AS lead_cost_earned,
    0::float8                                                   AS lead_cost_open,
    0::float8                                                   AS lead_cost_dead
  FROM g WHERE g.affiliate_id IS NOT NULL GROUP BY 1
),
-- Partner names live in altercpa_webmasters and are operator-editable — a
-- rename is one UPDATE there, reflected on next load. Unnamed webmasters show
-- as "WM <id>" so they are identifiable, never "(unknown)" en masse.
aff_named AS (
  SELECT a.*,
         coalesce(w.name, 'WM ' || a.affiliate_id) AS name,
         a.affiliate_id                            AS code
  FROM aff a LEFT JOIN public.altercpa_webmasters w ON w.wm_id = a.affiliate_id
),
-- Attribution coverage, read from the DATA (never from migration filenames).
-- The UI warns when the requested range starts before a channel could be
-- attributed at all. CPA attribution was backfilled over the full history
-- import; prediction attribution starts 2026-08-14.
bounds AS (
  SELECT (SELECT min(created_at) FROM public.orders
           WHERE cpa_webmaster_id IS NOT NULL
              OR external_source = 'altercpa')     AS first_affiliate_lead_at,
         (SELECT min(created_at) FROM public.orders
           WHERE prediction_list_id IS NOT NULL)   AS first_prediction_attr_at
)
SELECT jsonb_build_object(
  'channels',       (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM chan x),
  'packages',       (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM pkg x),
  'cogs_units',     (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM cogs_units x),
  'logistics',      (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM logi x),
  'agents',         (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM ag x),
  'by_affiliate',   (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM aff_named x),
  'aff_packages',   (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM pkg_aff x),
  'aff_cogs_units', (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM cogs_units_aff x),
  'aff_logistics',  (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM logi_aff x),
  'aff_agents',     (SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM ag_aff x),
  -- Zero payout ⇒ zero accrual; shape kept for parity with BG's response.
  'accrual',        jsonb_build_object(
                      'lead_cost_confirmed_in_range', 0,
                      'lead_cost_orders_confirmed_in_range', 0,
                      'lead_cost_earned_no_timestamp', 0,
                      'orphan_leads', 0),
  'bounds',         (SELECT to_jsonb(b) FROM bounds b)
)
$$;
COMMENT ON FUNCTION public.insights_channel_pl(text, text) IS
  'Per-channel and per-webmaster P&L counters for GET /management-insights. Raw and unrounded; rate card and normAgent stay in TS. Lead cost is 0 pending per-webmaster rates.';

-- Channel P&L is margin data. Even though this market has no external partner
-- logins today, the lockdown is the same as Bulgaria's: service_role ONLY.
REVOKE ALL ON FUNCTION public.insights_channel_pl(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.insights_channel_pl(text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_channel_pl(text, text) TO service_role;

REVOKE ALL ON FUNCTION public.order_channel(text, uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.order_channel(text, uuid, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.order_channel(text, uuid, boolean) TO service_role;

-- NO NEW INDEX, deliberately — BG measured the equivalent base filter at ~11ms
-- on a plain Seq Scan over a larger table; this one is 88k rows. The partial
-- index on cpa_webmaster_id (20260927000100) already covers the bounds probe.
