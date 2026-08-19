-- ============================================================================
-- AGENT SELF-ANALYTICS (2026-08-19) — the operator dashboard stops reading zero
--
-- Complaint (operator, 2026-08-19): "Операторите немаат можност самите да ги
-- видат своите нарачки." The dashboard existed; it just could not find their
-- work, because GET /dashboard-stats scopes with salesOwnerOrFilter(uid) — the
-- UUID legs only — and this database attributes orders by NAME:
--
--     orders total                        88.645
--     assigned_agent_id     IS NOT NULL      902
--     confirmed_by_agent_id IS NOT NULL      202
--     assigned_agent_name   IS NOT NULL   67.970
--     confirmed_by_name     IS NOT NULL   34.959
--
-- GET /agent-performance already solves this with the script fold
-- (agentIdentityKey -> buildAgentIdentityIndex -> agentOwnerKey). Same person,
-- two answers: Sashka Simonovska reads 0 orders by UUID and 6.403 by folded
-- name. These functions give the agent dashboard the SAME attribution, so the
-- two surfaces can never disagree again.
--
-- ── THE RULE THAT MAKES THIS SAFE (inherited verbatim from
--    20260924000000_agent_performance_rollup.sql) ────────────────────────────
-- Only the row loop lives in SQL. NOTHING identity-shaped is ported:
--   * agentIdentityKey()/normAgentName() are NEVER written in SQL. The caller
--     folds in TypeScript and passes the resulting raw spellings as an explicit
--     p_owner_names array. Postgres has no \p{L}; porting the fold would
--     re-litigate the 2026-08-14 identity ruling.
--   * The exact-name BONUS gate stays in TS too — and that is why there are
--     TWO name arrays. p_owner_names is the FOLDED set (drives counts and
--     revenue); p_bonus_names is the narrower EXACT-name set (drives bonus
--     alone). Folding the bonus index would silently add 15.985 EUR — see
--     scripts/audit-agent-identity-merge.mjs. Passing the two arrays keeps the
--     gate identical to /agent-performance, so payout CANNOT move.
--   * p_lead_sources is LEAD_SOURCE_TYPES handed down from the edge function,
--     so "what counts as a pending" has one definition, not two.
--   * NOTHING IS ROUNDED HERE. Raw sums out; TS rounds where paidRevenueOf()
--     and calcAgentBonus() round.
--
-- Read-side only. No writes, no schema changes.
-- ============================================================================

-- ── 1. Distinct operator spellings, so TS can fold them ─────────────────────
-- PostgREST cannot do DISTINCT, and re-deriving this per request would scan
-- orders every time. ~90 rows; the edge function memoises it for 10 minutes.
-- `n` lets the caller label a spelling by how much history actually uses it,
-- exactly like /agent-performance's virtualVariants.
CREATE OR REPLACE FUNCTION public.agent_owner_name_variants()
RETURNS TABLE (owner_raw text, n int)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC'
AS $fn$
  SELECT coalesce(o.confirmed_by_name, o.assigned_agent_name) AS owner_raw,
         count(*)::int AS n
  FROM public.orders o
  WHERE coalesce(o.confirmed_by_name, o.assigned_agent_name) IS NOT NULL
    AND (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
  GROUP BY 1
$fn$;
COMMENT ON FUNCTION public.agent_owner_name_variants() IS
  'Distinct operator spellings on orders, with row counts. The identity fold happens in TS.';
REVOKE ALL ON FUNCTION public.agent_owner_name_variants() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_owner_name_variants() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_owner_name_variants() TO service_role;


-- ── 2. The agent's own book, split by sales motion ──────────────────────────
-- Windowing reproduces the legacy dashboard-stats fetch verbatim: the activity
-- window (created_at) MERGED with the earnings window (paid_at), so COD
-- collected this period on an older order still counts toward packages and
-- payout.
CREATE OR REPLACE FUNCTION public.agent_self_stats(
  p_owner_id uuid,
  p_owner_names text[],
  p_bonus_names text[],
  p_lead_sources text[],
  p_from text,
  p_to text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $fn$
WITH owned AS (
  SELECT o.id, o.status::text AS status, o.price, o.quantity, o.paid_at, o.created_at,
         o.source_type, o.prediction_list_id, o.prediction_list_name,
         coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) AS owner_id,
         coalesce(o.confirmed_by_name, o.assigned_agent_name)   AS owner_raw
  FROM public.orders o
  WHERE (o.source_type IS NULL OR o.source_type <> 'monadon_legacy')
    -- salesOwnerId() / salesOwnerName(), as one predicate. The name leg only
    -- applies when NO account id was recorded — an order that names an agent
    -- but belongs to another account by id stays with the id.
    AND ( coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) = p_owner_id
       OR ( coalesce(o.confirmed_by_agent_id, o.assigned_agent_id) IS NULL
            AND coalesce(o.confirmed_by_name, o.assigned_agent_name) = ANY (p_owner_names) ) )
),
base AS (
  SELECT * FROM owned o
  WHERE
    -- (1) activity window: created_at in range (everything when no range)
    ( (nullif(p_from, '') IS NULL OR o.created_at >= nullif(p_from, '')::timestamptz)
      AND (nullif(p_to, '') IS NULL OR o.created_at <= nullif(p_to, '')::timestamptz) )
    OR
    -- (2) earnings window: paid this period, created earlier. Only when a
    --     range is set — without one, branch (1) already has every row.
    ( (nullif(p_from, '') IS NOT NULL OR nullif(p_to, '') IS NOT NULL)
      AND o.status = 'paid'
      AND (nullif(p_from, '') IS NULL OR o.paid_at >= nullif(p_from, '')::timestamptz)
      AND (nullif(p_to, '')   IS NULL OR o.paid_at <= nullif(p_to, '')::timestamptz) )
),
it AS (
  SELECT i.order_id,
         count(*)::int                     AS n_items,
         coalesce(sum(i.quantity), 0)::int AS q_sum,
         -- orderPackageBonus() items branch: packageBonusRate(price_per_unit) * quantity
         coalesce(sum(
           (CASE WHEN coalesce(i.price_per_unit, 0) >= 35 THEN 3
                 WHEN coalesce(i.price_per_unit, 0) >  25 THEN 2
                 ELSE 1 END) * coalesce(i.quantity, 0)), 0)::int AS bonus_items
  FROM public.order_items i
  JOIN base b ON b.id = i.order_id
  GROUP BY i.order_id
),
g AS (
  SELECT b.status, b.price, b.owner_id, b.owner_raw,
         -- Sales motion. Pendings win the tie: a lead the customer sent us is a
         -- pending even if it later picked up a list tag. `other` is the
         -- pre-CRM import — real work, but it predates the split, so it is
         -- reported in the totals only and never invented into a column.
         CASE
           WHEN b.source_type = ANY (p_lead_sources) THEN 'pendings'
           WHEN b.prediction_list_id IS NOT NULL
             OR b.prediction_list_name IS NOT NULL
             OR b.source_type = 'manual' THEN 'prediction'
           ELSE 'other'
         END AS channel,
         -- unitsOf(): items.length ? sum(qty) : (num(quantity) || 1)
         CASE WHEN coalesce(t.n_items, 0) > 0 THEN coalesce(t.q_sum, 0)
              WHEN coalesce(b.quantity, 0) = 0 THEN 1 ELSE b.quantity END AS units,
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
         -- THE EXACT-NAME BONUS GATE, unchanged from /agent-performance: an
         -- order earns for this agent when it carries their account id, or
         -- when its operator spelling is one of their EXACT-name variants.
         -- Never p_owner_names — that is the folded set.
         ( b.owner_id = p_owner_id
           OR (b.owner_id IS NULL AND b.owner_raw = ANY (p_bonus_names)) ) AS earns_bonus,
         -- inPaidWindow(): paid, with the coalesce(paid_at, created_at) fallback.
         ( b.status = 'paid' AND (
             (nullif(p_from, '') IS NULL AND nullif(p_to, '') IS NULL)
             OR ( (nullif(p_from, '') IS NULL
                   OR coalesce(b.paid_at, b.created_at) >= nullif(p_from, '')::timestamptz)
              AND (nullif(p_to, '') IS NULL
                   OR coalesce(b.paid_at, b.created_at) <= nullif(p_to, '')::timestamptz) )
         )) AS is_earn
  FROM base b
  LEFT JOIN it t ON t.order_id = b.id
),
-- Per-channel rollup, plus a '__total' row so the caller never has to add up
-- columns it cannot see (an order in `other` belongs to the total).
per AS (
  SELECT * FROM (
    SELECT g.channel,
      count(*)::int                                                     AS orders,
      -- "confirmed" = the agent got a yes, whatever happened downstream.
      -- Same status set /agent-performance uses, so the two agree.
      count(*) FILTER (WHERE g.status IN ('confirmed','shipped','delivered','returned','paid'))::int AS confirmed,
      count(*) FILTER (WHERE g.status IN ('shipped','delivered','returned','paid'))::int             AS shipped,
      count(*) FILTER (WHERE g.status = 'returned')::int                AS returned,
      count(*) FILTER (WHERE g.status = 'cancelled')::int               AS cancelled,
      count(*) FILTER (WHERE g.status = 'trashed')::int                 AS trashed,
      count(*) FILTER (WHERE g.status = 'call_again')::int              AS call_again,
      count(*) FILTER (WHERE g.is_earn)::int                            AS paid,
      coalesce(sum(g.price) FILTER (WHERE g.status IN ('confirmed','shipped','delivered','returned','paid')), 0) AS revenue_confirmed,
      coalesce(sum(g.price) FILTER (WHERE g.is_earn), 0)                AS revenue_paid,
      coalesce(sum(g.units) FILTER (WHERE g.is_earn), 0)::int           AS packages_sold,
      coalesce(sum(g.units) FILTER (WHERE g.status IN ('confirmed','shipped','delivered')), 0)::int AS packages_awaiting,
      coalesce(sum(g.units) FILTER (WHERE g.status = 'returned'), 0)::int AS packages_returned,
      coalesce(sum(g.bonus) FILTER (WHERE g.is_earn AND g.earns_bonus), 0)::int AS bonus_raw
    FROM g GROUP BY g.channel
    UNION ALL
    SELECT '__total',
      count(*)::int,
      count(*) FILTER (WHERE g.status IN ('confirmed','shipped','delivered','returned','paid'))::int,
      count(*) FILTER (WHERE g.status IN ('shipped','delivered','returned','paid'))::int,
      count(*) FILTER (WHERE g.status = 'returned')::int,
      count(*) FILTER (WHERE g.status = 'cancelled')::int,
      count(*) FILTER (WHERE g.status = 'trashed')::int,
      count(*) FILTER (WHERE g.status = 'call_again')::int,
      count(*) FILTER (WHERE g.is_earn)::int,
      coalesce(sum(g.price) FILTER (WHERE g.status IN ('confirmed','shipped','delivered','returned','paid')), 0),
      coalesce(sum(g.price) FILTER (WHERE g.is_earn), 0),
      coalesce(sum(g.units) FILTER (WHERE g.is_earn), 0)::int,
      coalesce(sum(g.units) FILTER (WHERE g.status IN ('confirmed','shipped','delivered')), 0)::int,
      coalesce(sum(g.units) FILTER (WHERE g.status = 'returned'), 0)::int,
      coalesce(sum(g.bonus) FILTER (WHERE g.is_earn AND g.earns_bonus), 0)::int
    FROM g
  ) q
),
-- Window-independent: how many of the agent's leads are parked on a callback
-- RIGHT NOW. A period figure cannot answer "what do I still owe a call to".
open_ca AS (
  SELECT count(*)::int AS n FROM owned WHERE status = 'call_again'
)
SELECT jsonb_build_object(
  'channels', coalesce((SELECT jsonb_object_agg(p.channel, to_jsonb(p) - 'channel') FROM per p), '{}'::jsonb),
  'call_again_open', (SELECT n FROM open_ca)
)
$fn$;
COMMENT ON FUNCTION public.agent_self_stats(uuid, text[], text[], text[], text, text) IS
  'One agent own book for GET /dashboard-stats, split pendings/prediction/other. Identity fold and the exact-name bonus gate stay in TS: p_owner_names is folded, p_bonus_names is exact.';
REVOKE ALL ON FUNCTION public.agent_self_stats(uuid, text[], text[], text[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_self_stats(uuid, text[], text[], text[], text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_self_stats(uuid, text[], text[], text[], text, text) TO service_role;


-- ── 3. What the agent actually DID in the window ────────────────────────────
-- The created_at window answers "orders that were born this period", which is
-- NOT the question an operator asks at the end of a shift. Cancelling a
-- three-month-old prediction lead today is a full day of work that scored zero
-- on the old tiles. order_history is the ledger of dispositions, so this is
-- where "обработени / потврдени / откажани / call-again / trash денес" comes
-- from.
--
-- WARNING: order_history only starts 2026-08-01 in this database. LIFETIME
-- totals must come from agent_self_stats, never from here — this function will
-- silently under-report any window reaching back before that date.
CREATE OR REPLACE FUNCTION public.agent_self_activity(
  p_owner_id uuid,
  p_owner_names text[],
  p_lead_sources text[],
  p_from text,
  p_to text)
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp SET TimeZone = 'UTC' SET work_mem = '64MB'
AS $fn$
WITH acts AS (
  SELECT h.order_id, h.to_status::text AS to_status,
         -- The order's CURRENT status, not the transition. Needed because a
         -- lead can be confirmed and then cancelled inside the same window:
         -- counting the 'confirmed' transition alone reported a 100% hit rate
         -- for an agent whose every order was later killed.
         o.status::text AS now_status,
         CASE
           WHEN o.source_type = ANY (p_lead_sources) THEN 'pendings'
           WHEN o.prediction_list_id IS NOT NULL
             OR o.prediction_list_name IS NOT NULL
             OR o.source_type = 'manual' THEN 'prediction'
           ELSE 'other'
         END AS channel
  FROM public.order_history h
  JOIN public.orders o ON o.id = h.order_id
  WHERE (nullif(p_from, '') IS NULL OR h.changed_at >= nullif(p_from, '')::timestamptz)
    AND (nullif(p_to, '')   IS NULL OR h.changed_at <= nullif(p_to, '')::timestamptz)
    -- Cron actors write here too ("System (mex:reconciliation)" alone is 7.551
    -- rows). They are not anybody's work.
    AND h.changed_by_name IS NOT NULL
    AND h.changed_by_name NOT LIKE 'System (%'
    AND ( h.changed_by = p_owner_id
       OR ( h.changed_by IS NULL AND (
              h.changed_by_name = ANY (p_owner_names)
              -- Some rows append a note: 'Ana Ristova — Products synced (...)'.
              -- Prefix match, never LIKE '%name%' — a substring would collect a
              -- colleague whose name merely contains this one.
              OR EXISTS (SELECT 1 FROM unnest(p_owner_names) v
                         WHERE h.changed_by_name LIKE v || ' %') ) ) )
),
-- Collapse to ONE row per order first. Counting straight off `acts` made
-- `won` count every order the agent so much as touched, including ones whose
-- only transition was 'take' — which produced a channel showing 11 wins out of
-- 0 processed. Channel and now_status are constant per order, so min() just
-- picks the value.
ord AS (
  SELECT a.order_id,
         min(a.channel)    AS channel,
         min(a.now_status) AS now_status,
         bool_or(a.to_status IN ('confirmed','cancelled','trashed','call_again')) AS t_processed,
         bool_or(a.to_status = 'confirmed')  AS t_confirmed,
         bool_or(a.to_status = 'cancelled')  AS t_cancelled,
         bool_or(a.to_status = 'trashed')    AS t_trashed,
         bool_or(a.to_status = 'call_again') AS t_call_again
  FROM acts a GROUP BY a.order_id
),
per AS (
  SELECT * FROM (
    SELECT o.channel,
      count(*) FILTER (WHERE o.t_processed)::int  AS processed,
      count(*) FILTER (WHERE o.t_confirmed)::int  AS confirmed,
      count(*) FILTER (WHERE o.t_cancelled)::int  AS cancelled,
      count(*) FILTER (WHERE o.t_trashed)::int    AS trashed,
      count(*) FILTER (WHERE o.t_call_again)::int AS call_again,
      -- Where the leads I worked ACTUALLY stand now. `won` is the honest
      -- numerator for realizacija; the 'confirmed' transition above is not,
      -- because a confirm that was cancelled an hour later still counts there.
      -- Both are gated on t_processed so they can never exceed it.
      count(*) FILTER (WHERE o.t_processed AND o.now_status IN ('confirmed','shipped','delivered','paid'))::int AS won,
      count(*) FILTER (WHERE o.t_processed AND o.now_status IN ('cancelled','trashed','returned'))::int         AS lost
    FROM ord o GROUP BY o.channel
    UNION ALL
    SELECT '__total',
      count(*) FILTER (WHERE o.t_processed)::int,
      count(*) FILTER (WHERE o.t_confirmed)::int,
      count(*) FILTER (WHERE o.t_cancelled)::int,
      count(*) FILTER (WHERE o.t_trashed)::int,
      count(*) FILTER (WHERE o.t_call_again)::int,
      count(*) FILTER (WHERE o.t_processed AND o.now_status IN ('confirmed','shipped','delivered','paid'))::int,
      count(*) FILTER (WHERE o.t_processed AND o.now_status IN ('cancelled','trashed','returned'))::int
    FROM ord o
  ) q
)
SELECT coalesce((SELECT jsonb_object_agg(p.channel, to_jsonb(p) - 'channel') FROM per p), '{}'::jsonb)
$fn$;
COMMENT ON FUNCTION public.agent_self_activity(uuid, text[], text[], text, text) IS
  'Dispositions an agent made in a window, from order_history, split by sales motion. order_history starts 2026-08-01, so never use this for lifetime totals.';
REVOKE ALL ON FUNCTION public.agent_self_activity(uuid, text[], text[], text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.agent_self_activity(uuid, text[], text[], text, text) FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_self_activity(uuid, text[], text[], text, text) TO service_role;


-- Attribution + window indexes. The name legs are exactly what the old
-- UUID-only filter could not use, and they are now on the hot path for 32
-- operators refreshing their own dashboard.
CREATE INDEX IF NOT EXISTS idx_orders_confirmed_by_name ON public.orders (confirmed_by_name);
CREATE INDEX IF NOT EXISTS idx_orders_assigned_agent_name ON public.orders (assigned_agent_name);
CREATE INDEX IF NOT EXISTS idx_order_history_changed_at ON public.order_history (changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_order_history_changed_by_name ON public.order_history (changed_by_name);
