-- ============================================================================
-- AGENT PERFORMANCE ROLLUP (2026-08-14) — the Agents tab stops streaming 80k rows
--
-- GET /agent-performance streamed every attributed order (plus order_items)
-- into the edge function 1000 rows at a time — two windows when a range is set
-- (created_at + paid_at), the ENTIRE table when the "Start" preset sends no
-- range — then ran ~12 Array.filter passes per agent. All-time exceeded the
-- edge function's CPU budget, which KILLS the isolate: the browser saw an
-- eternal spinner, never an error.
--
-- This function does the same arithmetic as one GROUP BY over
-- (owner_id, owner_raw) and returns a few hundred rows instead of ~80,000.
--
-- ── THE RULE THAT MAKES THIS SAFE (same as insights_orders_rollup) ─────────
-- Only the row loop moves into SQL. Everything identity- and money-shaped
-- stays in TypeScript, untouched:
--   * normAgentName() / agentIdentityKey() are NEVER ported. SQL groups by the
--     RAW owner spelling; TS folds scripts and merges. (Postgres has no \p{L};
--     porting the fold would re-litigate the 2026-08-14 identity ruling.)
--   * The exact-name BONUS index stays in TS. Per group, earnsBonus is
--     constant: a group with owner_id set always earns; a name-only group
--     earns iff the exact normalised spelling maps to the agent's account.
--     TS applies that gate per group and sums — payout totals cannot move.
--     (Folding the bonus index would silently add €15,985 — see
--     scripts/audit-agent-identity-merge.mjs and the endpoint comment.)
--   * NOTHING IS ROUNDED HERE. Raw sums out; TS rounds exactly where the
--     legacy code rounds (paidRevenueOf, calcAgentBonus, the rate formulas).
--
-- Two-window semantics reproduced from the legacy fetch, verbatim:
--   * created_at branch: the 9-status set, optional p_status, optional
--     p_source, and at least one attribution column present.
--   * paid_at branch: EXISTS ONLY when a range is set; status='paid' only;
--     p_source applies but p_status and the attribution filter DO NOT —
--     exactly like the legacy second query. The OR dedups the byId merge.
--   * p_earn_windowed = (date_basis == 'paid_at' && (from || to)) is computed
--     by the caller. When true, is_earn re-checks coalesce(paid_at,
--     created_at) against the SAME [p_from, p_to] — inPaidWindow()'s
--     created_at fallback included.
--
-- Known micro-divergence, documented on purpose: inPaidWindow() compares raw
-- ISO STRINGS in JS while this compares timestamptz. They differ only for a
-- paid_at with fractional seconds landing exactly on a date-only boundary's
-- final second. The parity harness decides whether that ever matters on real
-- data; if it flags a BLOCKER, add a js_ts_text() helper — do not "fix" the
-- window by hand.
--
-- Cost reproduces the legacy costMap exactly, including its two DIFFERENT
-- quantity fallbacks: cost uses (quantity || 1) while units use
-- unitsOf()'s (quantity || 0, then whole-order 1). Both are kept distinct.
--
-- SET TimeZone='UTC' is load-bearing: 'YYYY-MM-DD' bounds resolve to UTC
-- midnight exactly as PostgREST resolved the legacy .gte/.lte filters.
--
-- Read-side only. No writes, no schema changes.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.agent_performance_rollup(
  p_from text, p_to text, p_source text, p_status text, p_earn_windowed boolean)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $$
WITH base AS (
  SELECT o.id, o.status::text AS status, o.price, o.quantity, o.product_id,
         o.paid_at, o.created_at,
         -- salesOwnerId()/salesOwnerName(): JS `??` skips null/undefined but
         -- NOT '', which is exactly what coalesce does.
         coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) AS owner_id,
         coalesce(o.confirmed_by_name, o.assigned_agent_name)   AS owner_raw
  FROM public.orders o
  WHERE (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    AND (nullif(p_source, '') IS NULL OR o.source_type = p_source)
    AND (
      -- (1) activity window: created_at in range (or everything when no range)
      ( o.status::text = ANY (ARRAY['take','call_again','confirmed','shipped',
                                    'delivered','returned','paid','trashed','cancelled'])
        AND (nullif(p_status, '') IS NULL OR o.status::text = p_status)
        AND (o.confirmed_by_agent_id IS NOT NULL OR o.assigned_agent_id IS NOT NULL
             OR o.confirmed_by_name IS NOT NULL OR o.assigned_agent_name IS NOT NULL)
        AND (nullif(p_from, '') IS NULL OR o.created_at >= nullif(p_from, '')::timestamptz)
        AND (nullif(p_to, '')   IS NULL OR o.created_at <= nullif(p_to, '')::timestamptz) )
      OR
      -- (2) earnings window: paid_at in range — only when a range is set, no
      --     status filter, no attribution filter (legacy second query).
      ( (nullif(p_from, '') IS NOT NULL OR nullif(p_to, '') IS NOT NULL)
        AND o.status = 'paid'
        AND (nullif(p_from, '') IS NULL OR o.paid_at >= nullif(p_from, '')::timestamptz)
        AND (nullif(p_to, '')   IS NULL OR o.paid_at <= nullif(p_to, '')::timestamptz) )
    )
),
it AS (
  SELECT i.order_id,
         count(*)::int                     AS n_items,
         coalesce(sum(i.quantity), 0)::int AS q_sum,
         -- orderPackageBonus items branch: packageBonusRate(price_per_unit) * quantity
         coalesce(sum(
           (CASE WHEN coalesce(i.price_per_unit, 0) >= 35 THEN 3
                 WHEN coalesce(i.price_per_unit, 0) >  25 THEN 2
                 ELSE 1 END) * coalesce(i.quantity, 0)), 0)::int AS bonus_items,
         -- legacy costMap: (costMap[product_id] || 0) * (quantity || 1) —
         -- note the || 1 fallback, DIFFERENT from unitsOf()'s || 0.
         coalesce(sum(
           coalesce(pr.cost_price, 0)::float8
           * (CASE WHEN coalesce(i.quantity, 0) = 0 THEN 1 ELSE i.quantity END)::float8), 0) AS cost_items
  FROM public.order_items i
  JOIN base b ON b.id = i.order_id
  LEFT JOIN public.products pr ON pr.id = i.product_id
  GROUP BY i.order_id
),
g AS (
  SELECT b.status, b.price, b.owner_id, b.owner_raw,
         -- unitsOf(): items.length ? Σqty : (num(quantity) || 1)
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
              WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END AS units,
         -- order cost: items branch, else legacy product_id branch, else 0
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.cost_items, 0)
              WHEN b.product_id IS NOT NULL THEN
                   coalesce(pr.cost_price, 0)::float8
                   * (CASE WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END)::float8
              ELSE 0 END AS cost,
         -- orderPackageBonus(): legacy branch divides then compares in float8,
         -- exactly as the TS does (tier boundary is > 25, not >= 25).
         CASE WHEN b.status <> 'paid' THEN 0
              WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.bonus_items, 0)
              ELSE (CASE WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(b.price,0)::float8
                            / (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)::float8 >  25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(b.quantity,0)=0 THEN 1 ELSE b.quantity END)
         END::int AS bonus,
         -- earnings membership (legacy lines 9141-9143): paid, and when the
         -- caller says the earnings window applies, inPaidWindow() with its
         -- coalesce(paid_at, created_at) fallback against the SAME bounds.
         ( b.status = 'paid' AND (
             NOT p_earn_windowed
             OR ( (nullif(p_from, '') IS NULL
                   OR coalesce(b.paid_at, b.created_at) >= nullif(p_from, '')::timestamptz)
              AND (nullif(p_to, '') IS NULL
                   OR coalesce(b.paid_at, b.created_at) <= nullif(p_to, '')::timestamptz) )
         )) AS is_earn
  FROM base b
  LEFT JOIN it t ON t.order_id = b.id
  LEFT JOIN public.products pr ON pr.id = b.product_id
),
grp AS (
  SELECT g.owner_id, g.owner_raw,
    -- every attributed row, incl. trashed/cancelled — feeds virtualVariants
    -- spelling-frequency labels in TS
    count(*)::int                                                     AS n_rows,
    count(*) FILTER (WHERE g.status = 'trashed')::int                 AS n_trashed,
    count(*) FILTER (WHERE g.status = 'cancelled')::int               AS n_cancelled,
    -- lead base WITHOUT cancelled; TS adds n_cancelled when includeCancelled.
    -- (Cancelled affects only lead counts / rate denominators — it is outside
    -- every other status set below, so no other field needs the toggle.)
    count(*) FILTER (WHERE g.status NOT IN ('trashed','cancelled'))::int AS n_leads_nc,
    -- returned IS in the confirmed and shipped sets (legacy 9137-9138)
    count(*) FILTER (WHERE g.status IN ('confirmed','shipped','delivered','returned','paid'))::int AS n_confirmed,
    count(*) FILTER (WHERE g.status IN ('shipped','delivered','returned','paid'))::int             AS n_shipped,
    count(*) FILTER (WHERE g.status = 'returned')::int                AS n_returned,
    count(*) FILTER (WHERE g.is_earn)::int                            AS n_paid_earn,
    -- shipped+paid only — NOT delivered (legacy 9148-9150)
    coalesce(sum(g.price) FILTER (WHERE g.status IN ('shipped','paid')), 0)   AS gross_revenue,
    coalesce(sum(g.price) FILTER (WHERE g.is_earn), 0)                        AS paid_revenue_raw,
    coalesce(sum(g.price) FILTER (WHERE g.status = 'shipped'), 0)             AS outstanding_revenue,
    coalesce(sum(g.price) FILTER (WHERE g.status = 'returned'), 0)            AS returned_value,
    coalesce(sum(g.cost)  FILTER (WHERE g.is_earn), 0)                        AS paid_cost,
    coalesce(sum(g.cost)  FILTER (WHERE g.status = 'returned'), 0)            AS returned_cost,
    coalesce(sum(g.bonus) FILTER (WHERE g.is_earn), 0)::int                   AS bonus_earn,
    coalesce(sum(g.units) FILTER (WHERE g.is_earn), 0)::int                   AS pkgs_sold,
    coalesce(sum(g.units) FILTER (WHERE g.status IN ('confirmed','shipped','delivered')), 0)::int AS pkgs_awaiting,
    coalesce(sum(g.units) FILTER (WHERE g.status = 'returned'), 0)::int       AS pkgs_returned
  FROM g GROUP BY 1, 2
)
SELECT coalesce(jsonb_agg(to_jsonb(x)), '[]') FROM grp x
$$;
COMMENT ON FUNCTION public.agent_performance_rollup(text, text, text, text, boolean) IS
  'Per-(owner_id, owner_raw) rollups for GET /agent-performance. Identity fold, exact-name bonus gate and all rounding stay in TS.';
REVOKE ALL ON FUNCTION public.agent_performance_rollup(text, text, text, text, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_performance_rollup(text, text, text, text, boolean) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_performance_rollup(text, text, text, text, boolean) TO service_role;
