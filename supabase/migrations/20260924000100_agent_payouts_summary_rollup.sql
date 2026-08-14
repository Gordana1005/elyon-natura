-- ============================================================================
-- AGENT PAYOUTS SUMMARY ROLLUP (2026-08-14) — the Payout tab loses its N+1
--
-- GET /agent-payouts/summary looped over every gated agent profile and ran
-- THREE paginated scans per agent (all paid orders with the date window
-- applied only in JS, the awaiting pipeline, the returned window) — 150+
-- sequential scans for ~50 agents, minutes of wall clock.
--
-- This function collapses the loop to one GROUP BY per sub-aggregate, keyed
-- on the uuid owner (coalesce(confirmed_by_agent_id, assigned_agent_id) —
-- salesOwnerId() semantics; name attribution plays no role in payouts).
--
-- Same safety rule as agent_performance_rollup / the insights engine:
--   * NOTHING IS ROUNDED HERE — raw integer bonus sums and raw settled sums
--     out; TS applies calcAgentBonus()'s single Math.round exactly where the
--     legacy code did.
--   * Profile gating (is_active, agent-not-superadmin) stays in TS; this
--     returns activity for every owner and TS keeps only gated profiles,
--     defaulting zeros — exactly the legacy row-per-profile behaviour.
--   * The settled set replicates loadSettledOrderIds(): order ids on PAID
--     settlements — GLOBAL when the endpoint is unfiltered, scoped to the
--     agent when ?agent_id= is given. p_agent_id drives both that and the
--     owner filter, like the legacy code.
--   * The paid window is inPaidWindow(): coalesce(paid_at, created_at)
--     against the raw bounds (same string-vs-timestamptz micro-divergence
--     note as agent_performance_rollup). The returned window is a plain
--     returned_at >= / <= — PostgREST-level in legacy, so this one is exact.
--   * The awaiting pipeline has NO date window, on purpose (legacy
--     "not date-windowed tightly" comment).
--
-- SET TimeZone='UTC' pins date-only bounds to UTC midnight as PostgREST did.
-- Read-side only. No writes, no schema changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.agent_payouts_summary_rollup(
  p_from text, p_to text, p_agent_id uuid)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $$
WITH own_base AS (
  -- loadPaidOrdersForAgent(): paid, monadon excluded, uuid-owned, paid-event window
  SELECT o.id, o.price, o.quantity,
         coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) AS agent
  FROM public.orders o
  WHERE o.status = 'paid'
    AND (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) IS NOT NULL
    AND (p_agent_id IS NULL OR coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) = p_agent_id)
    AND (nullif(p_from, '') IS NULL OR coalesce(o.paid_at, o.created_at) >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to, '')   IS NULL OR coalesce(o.paid_at, o.created_at) <= nullif(p_to, '')::timestamptz)
),
own_it AS (
  SELECT i.order_id,
         count(*)::int                     AS n_items,
         coalesce(sum(i.quantity), 0)::int AS q_sum,
         -- orderPackageBonus items branch (all rows here are paid)
         coalesce(sum(
           (CASE WHEN coalesce(i.price_per_unit, 0) >= 35 THEN 3
                 WHEN coalesce(i.price_per_unit, 0) >  25 THEN 2
                 ELSE 1 END) * coalesce(i.quantity, 0)), 0)::int AS bonus_items
  FROM public.order_items i JOIN own_base b ON b.id = i.order_id
  GROUP BY 1
),
own AS (
  SELECT b.agent,
         -- unitsOf(): items.length ? Σqty : (num(quantity) || 1)
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
              WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END AS units,
         -- orderPackageBonus() legacy branch: float8 division, > 25 boundary
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.bonus_items, 0)
              ELSE (CASE WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >  25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)
         END::int AS bonus,
         -- loadSettledOrderIds(): on a PAID settlement; agent-scoped only when
         -- the endpoint itself is agent-filtered
         NOT EXISTS (
           SELECT 1 FROM public.agent_payout_items i
           JOIN public.agent_payouts ap ON ap.id = i.payout_id
           WHERE i.order_id = b.id AND ap.status = 'paid'
             AND (p_agent_id IS NULL OR ap.agent_user_id = p_agent_id)
         ) AS unsettled
  FROM own_base b LEFT JOIN own_it t ON t.order_id = b.id
),
own_g AS (
  SELECT agent,
         coalesce(sum(units), 0)::int                            AS packages_sold,
         coalesce(sum(bonus), 0)::int                            AS bonus_owned,
         coalesce(sum(bonus) FILTER (WHERE unsettled), 0)::int   AS bonus_unsettled,
         count(*)  FILTER (WHERE unsettled)::int                 AS unsettled_orders
  FROM own GROUP BY 1
),
aw_base AS (
  -- awaiting pipeline: confirmed/shipped/delivered, NO date window on purpose
  SELECT o.id, o.quantity,
         coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) AS agent
  FROM public.orders o
  WHERE o.status IN ('confirmed','shipped','delivered')
    AND (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) IS NOT NULL
    AND (p_agent_id IS NULL OR coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) = p_agent_id)
),
aw_it AS (
  SELECT i.order_id, count(*)::int AS n_items, coalesce(sum(i.quantity), 0)::int AS q_sum
  FROM public.order_items i JOIN aw_base b ON b.id = i.order_id GROUP BY 1
),
aw_g AS (
  SELECT b.agent,
         coalesce(sum(CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
                           WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END), 0)::int AS pkgs_awaiting
  FROM aw_base b LEFT JOIN aw_it t ON t.order_id = b.id GROUP BY 1
),
ret_base AS (
  -- returned_at window applied at the SQL level, exactly like the legacy
  -- PostgREST .gte/.lte (a NULL returned_at drops out only when a bound is set)
  SELECT o.id, o.quantity,
         coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) AS agent
  FROM public.orders o
  WHERE o.status = 'returned'
    AND (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) IS NOT NULL
    AND (p_agent_id IS NULL OR coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) = p_agent_id)
    AND (nullif(p_from, '') IS NULL OR o.returned_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to, '')   IS NULL OR o.returned_at <= nullif(p_to, '')::timestamptz)
),
ret_it AS (
  SELECT i.order_id, count(*)::int AS n_items, coalesce(sum(i.quantity), 0)::int AS q_sum
  FROM public.order_items i JOIN ret_base b ON b.id = i.order_id GROUP BY 1
),
ret_g AS (
  SELECT b.agent,
         coalesce(sum(CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
                           WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END), 0)::int AS pkgs_returned
  FROM ret_base b LEFT JOIN ret_it t ON t.order_id = b.id GROUP BY 1
),
setl AS (
  SELECT ap.agent_user_id AS agent,
         coalesce(sum(coalesce(ap.amount_eur, 0)), 0) AS settled_sum_raw,
         max(ap.paid_on)                              AS last_paid_on
  FROM public.agent_payouts ap
  WHERE ap.status = 'paid'
    AND (p_agent_id IS NULL OR ap.agent_user_id = p_agent_id)
  GROUP BY 1
),
allk AS (
  SELECT agent FROM own_g UNION SELECT agent FROM aw_g
  UNION SELECT agent FROM ret_g UNION SELECT agent FROM setl
)
SELECT coalesce(jsonb_agg(jsonb_build_object(
  'agent',            k.agent,
  'packages_sold',    coalesce(og.packages_sold, 0),
  'bonus_owned',      coalesce(og.bonus_owned, 0),
  'bonus_unsettled',  coalesce(og.bonus_unsettled, 0),
  'unsettled_orders', coalesce(og.unsettled_orders, 0),
  'pkgs_awaiting',    coalesce(ag.pkgs_awaiting, 0),
  'pkgs_returned',    coalesce(rg.pkgs_returned, 0),
  'settled_sum_raw',  coalesce(st.settled_sum_raw, 0),
  'last_paid_on',     st.last_paid_on
)), '[]')
FROM allk k
LEFT JOIN own_g og ON og.agent = k.agent
LEFT JOIN aw_g  ag ON ag.agent = k.agent
LEFT JOIN ret_g rg ON rg.agent = k.agent
LEFT JOIN setl  st ON st.agent = k.agent
$$;
COMMENT ON FUNCTION public.agent_payouts_summary_rollup(text, text, uuid) IS
  'Per-uuid-owner payout rollups for GET /agent-payouts/summary. Profile gating and calcAgentBonus rounding stay in TS.';
REVOKE ALL ON FUNCTION public.agent_payouts_summary_rollup(text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_payouts_summary_rollup(text, text, uuid) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_payouts_summary_rollup(text, text, uuid) TO service_role;
