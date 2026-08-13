-- ============================================================================
-- LEAD DISTRIBUTION ENGINE — make it real, continuous and product-aware.
--
-- Background (measured 2026-08-13): the CRM takes ~193 inbound leads a day
-- across 39 active call-floor agents, and NOTHING created on or after
-- 2026-08-07 had ever been assigned to anybody. In the whole 87k-row orders
-- table only 80 rows carried a real assigned_agent_id, all written in a single
-- manual burst on 2026-08-06 17:11 UTC. Leads simply aged out into
-- cancelled/trashed without ever reaching an agent's queue.
--
-- The /lead-distribution page LOOKED like a working system — three strategies,
-- an "Enable Auto-Distribution" switch, an "Engine Active" badge — but:
--   * lead_distribution_config.is_active was never read by any code path;
--   * no scheduler existed (the 11 live cron jobs cover segments, recordings,
--     postbacks, AlterCPA and MEX — none of them assign);
--   * the round_robin branch dropped every remaining order once the agent at
--     the current index hit the cap (it neither assigned nor advanced idx);
--   * the candidate pull had NO lead-source filter, so it would have handed out
--     legacy source_type='import' rows — a direct breach of lead rules 4 and 6;
--   * both the candidate pull and the load tally were subject to the PostgREST
--     1000-row cap, so max_leads_per_agent was enforced against undercounted
--     load;
--   * assignment ran one UPDATE round-trip per order in a serial loop, which
--     would time the edge function out long before a backlog drained.
--
-- ── Why this lives in Postgres and not the edge function ────────────────────
-- Moving the picker into SQL removes all four structural problems at once: no
-- row caps, no HTTP timeout, no per-row round-trips, and the UPDATE's
-- "AND assigned_agent_id IS NULL" guard makes double-assignment impossible
-- under concurrency. It also lets an AFTER INSERT trigger place a brand-new
-- lead inside the intake transaction, which is what "assigned immediately"
-- actually requires. Unlike the AlterCPA/MEX jobs, this scheduler talks to
-- nothing external, so it needs no pg_net hop at all.
--
-- ── The two layers ─────────────────────────────────────────────────────────
--   LAYER 1  ROUTING  — which agents are ALLOWED this lead?
--                       A product with routing rules prefers its specialists;
--                       a product without rules goes to everyone (the default).
--                       Nothing is absolute: if the specialists are full or
--                       offline the lead FALLS THROUGH to the whole floor
--                       rather than sitting unassigned.
--   LAYER 2  STRATEGY — which one of those agents?
--                       round_robin | load_balance | priority, with online
--                       agents preferred over offline ones.
--
-- Product routing is a LAYER, not a fourth strategy, so the existing
-- lead_distribution_config.strategy CHECK constraint is deliberately untouched.
--
-- ── Roles ──────────────────────────────────────────────────────────────────
-- Pendings and prediction lists are two different queues on two different
-- tables. pending_agent works inbound leads (39 of 40 staff hold it);
-- prediction_agent works prediction lists (28 hold it) — and because 101 role
-- grants are spread across 40 people, almost everyone holds both. Role
-- filtering therefore barely narrows anything, which is why participation is
-- controlled by an explicit per-agent opt-out table on top of the role list.
-- admin/manager are excluded unconditionally: they never own leads (the
-- commission rule credits the confirmer, and they are excluded from payout).
-- ============================================================================

-- ── 1. Config: the switch finally means something ──────────────────────────

ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS respect_online          boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS include_prediction_load boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS participating_roles     text[]  NOT NULL
    DEFAULT ARRAY['pending_agent','agent','inbound_agent']::text[],
  ADD COLUMN IF NOT EXISTS working_hours_only      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS order_direction         text    NOT NULL DEFAULT 'newest',
  ADD COLUMN IF NOT EXISTS last_run_at             timestamptz,
  ADD COLUMN IF NOT EXISTS last_run_assigned       integer NOT NULL DEFAULT 0;

ALTER TABLE public.lead_distribution_config
  DROP CONSTRAINT IF EXISTS lead_distribution_config_order_direction_check;
ALTER TABLE public.lead_distribution_config
  ADD CONSTRAINT lead_distribution_config_order_direction_check
  CHECK (order_direction IN ('newest', 'oldest'));

COMMENT ON COLUMN public.lead_distribution_config.is_active IS
  'The Start/Stop switch. Read by distribute_pending_leads() and by the AFTER INSERT trigger. Before 2026-08-13 nothing read this and the page was decoration.';
COMMENT ON COLUMN public.lead_distribution_config.priority_threshold IS
  'EUR, not denars and not dollars — orders.price is stored in EUR. A typical MK COD order is 20-40 EUR, so the inherited default of 500 disables the priority strategy entirely.';
COMMENT ON COLUMN public.lead_distribution_config.include_prediction_load IS
  'When true, max_leads_per_agent counts open prediction members as well as open leads, so an agent buried in prediction work is not also handed a full lead queue.';
COMMENT ON COLUMN public.lead_distribution_config.working_hours_only IS
  'Ships OFF by operator decision (2026-08-13): once started the engine runs until stopped. When on, distribution pauses outside 09:00-19:59 Europe/Skopje.';

-- Collapse to a single row. GET read the newest by updated_at while PATCH wrote
-- configs[0], so a second row would silently split read from write.
DELETE FROM public.lead_distribution_config a
 USING public.lead_distribution_config b
 WHERE (a.updated_at, a.id) < (b.updated_at, b.id);

INSERT INTO public.lead_distribution_config (strategy, is_active, max_leads_per_agent, priority_threshold)
SELECT 'round_robin', false, 50, 500
 WHERE NOT EXISTS (SELECT 1 FROM public.lead_distribution_config);

CREATE UNIQUE INDEX IF NOT EXISTS lead_distribution_config_singleton
  ON public.lead_distribution_config ((true));

-- ── 2. New tables ──────────────────────────────────────────────────────────
-- Deny-all RLS + REVOKE on every one: only the edge function (service role)
-- and pg_cron (postgres) ever touch them. Affiliates hold real Supabase
-- logins, so nothing new may become readable to `authenticated`.
-- See the 2026-08-04 security audit and .grok/skills/elyon-security.

-- Opt-in product overrides. Absence of any rule for a product = everyone.
CREATE TABLE IF NOT EXISTS public.lead_routing_rules (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  agent_id   uuid NOT NULL REFERENCES auth.users(id)      ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  UNIQUE (product_id, agent_id)
);
COMMENT ON TABLE public.lead_routing_rules IS
  'Opt-in per-product specialists. A product with no rows here goes to every participating agent. Rules PREFER, never restrict: pick_agent_for_lead falls through to the full floor when the specialists are at capacity or offline.';

ALTER TABLE public.lead_routing_rules ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_routing_rules FROM PUBLIC;
REVOKE ALL ON public.lead_routing_rules FROM anon;
REVOKE ALL ON public.lead_routing_rules FROM authenticated;

-- Per-agent participation. Absence = participating, so a new hire is included
-- automatically and nobody has to remember to add them.
CREATE TABLE IF NOT EXISTS public.lead_distribution_optout (
  agent_id   uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid
);
COMMENT ON TABLE public.lead_distribution_optout IS
  'Agents excluded from automatic lead distribution (holiday, training, prediction-only duty) without touching their roles. Absence of a row means participating.';

ALTER TABLE public.lead_distribution_optout ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_distribution_optout FROM PUBLIC;
REVOKE ALL ON public.lead_distribution_optout FROM anon;
REVOKE ALL ON public.lead_distribution_optout FROM authenticated;

-- Run history. The page has never been able to say why nothing happened.
CREATE TABLE IF NOT EXISTS public.lead_distribution_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ran_at         timestamptz NOT NULL DEFAULT now(),
  source         text NOT NULL DEFAULT 'cron'
                 CHECK (source IN ('cron', 'trigger', 'manual')),
  assigned       integer NOT NULL DEFAULT 0,
  considered     integer NOT NULL DEFAULT 0,
  skipped_reason text,
  per_agent      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_lead_distribution_runs_ran_at
  ON public.lead_distribution_runs (ran_at DESC);

ALTER TABLE public.lead_distribution_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.lead_distribution_runs FROM PUBLIC;
REVOKE ALL ON public.lead_distribution_runs FROM anon;
REVOKE ALL ON public.lead_distribution_runs FROM authenticated;

-- ── 3. Indexes for the two hot lookups ─────────────────────────────────────

-- The unassigned-lead pool, in distribution order. The lead-source list is
-- INLINED rather than expressed as is_lead_source(): a partial index built on
-- the function body would be tied to it, and 20260917000000 set that precedent
-- deliberately. Change the source list in FOUR places now: is_lead_source(),
-- that migration's index, this index, and LEAD_SOURCE_TYPES in the edge fn.
CREATE INDEX IF NOT EXISTS idx_orders_unassigned_leads
  ON public.orders (created_at DESC)
  WHERE assigned_agent_id IS NULL
    AND status = 'pending'
    AND source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned');

-- Round-robin asks "who has waited longest for a lead?" — max(assigned_at)
-- per agent, which this index answers without touching the heap.
CREATE INDEX IF NOT EXISTS idx_orders_agent_assigned_at
  ON public.orders (assigned_agent_id, assigned_at DESC)
  WHERE assigned_agent_id IS NOT NULL;

-- ── 4. Who can receive a lead right now ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.lead_distribution_candidates()
RETURNS TABLE (
  agent_id         uuid,
  full_name        text,
  open_leads       integer,
  open_members     integer,
  effective_load   integer,
  is_online        boolean,
  has_capacity     boolean,
  last_assigned_at timestamptz
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH cfg AS (
    SELECT * FROM public.lead_distribution_config LIMIT 1
  ),
  eligible AS (
    SELECT p.user_id, p.full_name, p.last_seen_at
    FROM public.profiles p
    CROSS JOIN cfg c
    WHERE p.is_active
      -- explicit per-agent participation switch
      AND NOT EXISTS (
        SELECT 1 FROM public.lead_distribution_optout o WHERE o.agent_id = p.user_id
      )
      -- holds at least one participating role
      AND EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = p.user_id AND r.role::text = ANY (c.participating_roles)
      )
      -- admins and managers never own leads
      AND NOT EXISTS (
        SELECT 1 FROM public.user_roles r
        WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager')
      )
  ),
  -- Lead load, using the ONE canonical definition (lead rule 6): the same
  -- status set and source set as assigned_pending_counts() and as the badge on
  -- the agent's own /calls queue. The old engine counted every open order
  -- regardless of source, so its numbers disagreed with what agents saw.
  leads AS (
    SELECT o.assigned_agent_id AS aid, count(*)::int AS n
    FROM public.orders o
    WHERE o.assigned_agent_id IS NOT NULL
      AND o.status IN ('pending', 'take', 'call_again')
      AND public.is_lead_source(o.source_type)
    GROUP BY 1
  ),
  members AS (
    SELECT m.assigned_agent_id AS aid, count(*)::int AS n
    FROM public.prediction_segment_members m
    WHERE m.assigned_agent_id IS NOT NULL
      AND NOT m.is_completed
    GROUP BY 1
  ),
  lastasg AS (
    SELECT o.assigned_agent_id AS aid, max(o.assigned_at) AS at
    FROM public.orders o
    WHERE o.assigned_agent_id IS NOT NULL
      AND o.assigned_at IS NOT NULL
    GROUP BY 1
  )
  SELECT
    e.user_id,
    e.full_name,
    COALESCE(l.n, 0),
    COALESCE(m.n, 0),
    COALESCE(l.n, 0) + CASE WHEN c.include_prediction_load THEN COALESCE(m.n, 0) ELSE 0 END,
    -- Same 2-minute heartbeat window the edge function's ONLINE_WINDOW_MS uses.
    (e.last_seen_at IS NOT NULL AND e.last_seen_at > now() - interval '2 minutes'),
    (COALESCE(l.n, 0) + CASE WHEN c.include_prediction_load THEN COALESCE(m.n, 0) ELSE 0 END)
      < c.max_leads_per_agent,
    la.at
  FROM eligible e
  CROSS JOIN cfg c
  LEFT JOIN leads   l  ON l.aid  = e.user_id
  LEFT JOIN members m  ON m.aid  = e.user_id
  LEFT JOIN lastasg la ON la.aid = e.user_id;
$$;

COMMENT ON FUNCTION public.lead_distribution_candidates() IS
  'One row per agent eligible to receive an inbound lead right now: participating role, not opted out, not admin/manager, with live lead load, prediction load, presence and remaining capacity.';
REVOKE ALL ON FUNCTION public.lead_distribution_candidates() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lead_distribution_candidates() TO service_role;

-- ── 5. Pick one agent for one lead (layer 1 + layer 2) ─────────────────────

CREATE OR REPLACE FUNCTION public.pick_agent_for_lead(
  _order_id   uuid,
  _extra_load jsonb DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg          public.lead_distribution_config%ROWTYPE;
  _price        numeric;
  _product_id   uuid;
  _product_name text;
  _ruled        uuid[];
  _high         boolean;
  _pick         uuid;
BEGIN
  SELECT * INTO _cfg FROM public.lead_distribution_config LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;

  SELECT o.price, o.product_id, o.product_name
    INTO _price, _product_id, _product_name
  FROM public.orders o
  WHERE o.id = _order_id;
  IF NOT FOUND THEN RETURN NULL; END IF;

  -- LAYER 1 — product routing. Match on product_id when the order carries one,
  -- otherwise on the free-text product_name: AlterCPA-imported orders have no
  -- product_id and order_items.product_id is nullable, so the NAME is the only
  -- key that spans the whole corpus.
  SELECT array_agg(r.agent_id) INTO _ruled
  FROM public.lead_routing_rules r
  JOIN public.products p ON p.id = r.product_id
  WHERE (_product_id IS NOT NULL AND r.product_id = _product_id)
     OR (_product_name IS NOT NULL AND lower(btrim(p.name)) = lower(btrim(_product_name)));

  _high := (_cfg.strategy = 'priority' AND COALESCE(_price, 0) >= _cfg.priority_threshold);

  -- LAYER 2 — strategy. Everything below is expressed as ORDER BY preference
  -- over the capacity-filtered pool, which is precisely what "prefer, never
  -- strand" means: a specialist sorts first, but if no specialist has capacity
  -- the next tier simply wins the row.
  SELECT c.agent_id INTO _pick
  FROM public.lead_distribution_candidates() c
  WHERE c.has_capacity
  ORDER BY
    -- 1. product specialists first (only when this product has any rules)
    (CASE WHEN _ruled IS NOT NULL AND c.agent_id = ANY (_ruled) THEN 0 ELSE 1 END),
    -- 2. online before offline, when the operator asked us to respect presence
    (CASE WHEN _cfg.respect_online AND NOT c.is_online THEN 1 ELSE 0 END),
    -- 3. the strategy proper.
    --    load_balance (and high-value leads under `priority`) go to the
    --    lightest agent; round_robin ignores standing load and instead uses
    --    key 4. `_extra_load` carries simulated assignments so a dry run
    --    spreads exactly the way a real run would — on a real run it is NULL
    --    and each iteration re-reads live load, which is already correct.
    (CASE
       WHEN _cfg.strategy = 'load_balance' OR _high
         THEN c.effective_load + COALESCE((_extra_load ->> c.agent_id::text)::int, 0)
       ELSE COALESCE((_extra_load ->> c.agent_id::text)::int, 0)
     END),
    -- 4. round_robin: whoever has waited longest for a lead. This is a
    --    stateless, self-correcting rotation — no cursor to drift, and unlike
    --    the old index-based loop it cannot skip the rest of the batch when
    --    one agent fills up.
    (CASE
       WHEN _cfg.strategy = 'load_balance' OR _high THEN NULL
       ELSE c.last_assigned_at
     END) ASC NULLS FIRST,
    random()
  LIMIT 1;

  RETURN _pick;
END;
$fn$;

COMMENT ON FUNCTION public.pick_agent_for_lead(uuid, jsonb) IS
  'Chooses the agent for one lead: product routing rules prefer their specialists, presence prefers online agents, then round_robin/load_balance/priority decides. Returns NULL when every candidate is at capacity. Never restricts absolutely - a narrowed pool always falls through to the full floor.';
REVOKE ALL ON FUNCTION public.pick_agent_for_lead(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pick_agent_for_lead(uuid, jsonb) TO service_role;

-- ── 6. Assign one lead ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.assign_one_lead(
  _order_id uuid,
  _by       text DEFAULT 'Auto-distribution'
)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _agent uuid;
  _name  text;
  _done  uuid;
BEGIN
  _agent := public.pick_agent_for_lead(_order_id);
  IF _agent IS NULL THEN RETURN NULL; END IF;

  SELECT p.full_name INTO _name FROM public.profiles p WHERE p.user_id = _agent;

  -- The assignment triple moves as ONE (lead rule 1). A NULL id must never
  -- leave a name behind — that "phantom owner" is what hid the take-lock bug
  -- for weeks. The IS NULL guard is also the concurrency guarantee: the
  -- every-minute cron and an AFTER INSERT trigger firing on the same row
  -- cannot both win.
  UPDATE public.orders o
     SET assigned_agent_id   = _agent,
         assigned_agent_name = _name,
         assigned_at         = now(),
         assigned_by         = _by
   WHERE o.id = _order_id
     AND o.assigned_agent_id IS NULL
  RETURNING o.id INTO _done;

  IF _done IS NULL THEN RETURN NULL; END IF;
  RETURN _agent;
END;
$fn$;

COMMENT ON FUNCTION public.assign_one_lead(uuid, text) IS
  'Picks an agent and stamps the assignment triple atomically. Returns the agent, or NULL when nobody had capacity or the row was won by a concurrent caller.';
REVOKE ALL ON FUNCTION public.assign_one_lead(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assign_one_lead(uuid, text) TO service_role;

-- ── 7. The sweeper / backlog drainer ───────────────────────────────────────

CREATE OR REPLACE FUNCTION public.distribute_pending_leads(
  _limit   integer DEFAULT 500,
  _dry_run boolean DEFAULT false,
  _source  text    DEFAULT 'cron'
)
RETURNS TABLE (
  assigned       integer,
  considered     integer,
  skipped_reason text,
  per_agent      jsonb
)
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg    public.lead_distribution_config%ROWTYPE;
  _row    record;
  _agent  uuid;
  _n      integer := 0;
  _seen   integer := 0;
  _per    jsonb   := '{}'::jsonb;
  _reason text    := NULL;
BEGIN
  assigned := 0; considered := 0; skipped_reason := NULL; per_agent := '{}'::jsonb;

  -- Only one distributor at a time: the every-minute cron and a manager's
  -- "Run once now" must never race. Non-blocking, transaction-scoped — a
  -- second caller just leaves. A dry run takes no lock; it writes nothing.
  IF NOT _dry_run AND NOT pg_try_advisory_xact_lock(hashtext('lead_distribution')::bigint) THEN
    skipped_reason := 'already_running';
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO _cfg FROM public.lead_distribution_config LIMIT 1;
  IF NOT FOUND THEN
    skipped_reason := 'no_config';
    RETURN NEXT; RETURN;
  END IF;

  -- Start/Stop. A dry run is allowed while stopped — that is the whole point
  -- of a preview.
  IF NOT _cfg.is_active AND NOT _dry_run THEN
    skipped_reason := 'engine_stopped';
    RETURN NEXT; RETURN;
  END IF;

  -- Ships off. When on: 09:00-19:59 Europe/Skopje, DST-proof (pg_cron is UTC).
  IF _cfg.working_hours_only
     AND extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 9 AND 19 THEN
    skipped_reason := 'outside_working_hours';
    RETURN NEXT; RETURN;
  END IF;

  FOR _row IN
    SELECT o.id
    FROM public.orders o
    WHERE o.assigned_agent_id IS NULL
      AND o.status = 'pending'
      AND public.is_lead_source(o.source_type)
    ORDER BY
      CASE WHEN _cfg.order_direction = 'oldest' THEN o.created_at END ASC,
      CASE WHEN _cfg.order_direction = 'newest' THEN o.created_at END DESC
    LIMIT GREATEST(COALESCE(_limit, 500), 0)
  LOOP
    _seen := _seen + 1;

    IF _dry_run THEN
      -- Feed the accumulating tally back in so the preview spreads exactly the
      -- way a real run would instead of naming the same agent every time.
      _agent := public.pick_agent_for_lead(_row.id, _per);
    ELSE
      _agent := public.assign_one_lead(_row.id, 'Auto-distribution');
    END IF;

    IF _agent IS NOT NULL THEN
      _n   := _n + 1;
      _per := jsonb_set(
                _per,
                ARRAY[_agent::text],
                to_jsonb(COALESCE((_per ->> _agent::text)::int, 0) + 1)
              );
    END IF;
  END LOOP;

  IF _seen = 0 THEN
    _reason := 'no_leads';
  ELSIF _n = 0 THEN
    _reason := 'no_capacity';
  END IF;

  IF NOT _dry_run THEN
    INSERT INTO public.lead_distribution_runs (source, assigned, considered, skipped_reason, per_agent)
    VALUES (COALESCE(_source, 'cron'), _n, _seen, _reason, _per);

    UPDATE public.lead_distribution_config
       SET last_run_at = now(), last_run_assigned = _n;
  END IF;

  assigned := _n; considered := _seen; skipped_reason := _reason; per_agent := _per;
  RETURN NEXT;
END;
$fn$;

COMMENT ON FUNCTION public.distribute_pending_leads(integer, boolean, text) IS
  'Drains the unassigned inbound-lead pool. Gated on lead_distribution_config.is_active, advisory-locked against the cron, newest-first by default. _dry_run returns the plan without writing anything and simulates load as it goes.';
REVOKE ALL ON FUNCTION public.distribute_pending_leads(integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_pending_leads(integer, boolean, text) TO service_role;

-- ── 8. The trigger — "immediately" ─────────────────────────────────────────
-- A lead is owned before its intake transaction commits.
--
-- Postgres fires AFTER INSERT triggers in name order, so trg_orders_auto_distribute
-- runs before trg_orders_segments_insert. That is harmless: the segment engine
-- deliberately parks any phone with a live lead out of every prediction list.

CREATE OR REPLACE FUNCTION public.trg_orders_auto_distribute()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _cfg public.lead_distribution_config%ROWTYPE;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN RETURN NULL; END IF;
  IF NEW.status <> 'pending' THEN RETURN NULL; END IF;
  -- Leads only (rule 4). This is what keeps the 80.360-row source_type='import'
  -- history, and every agent-created 'manual' order, out of the call floor.
  IF NOT public.is_lead_source(NEW.source_type) THEN RETURN NULL; END IF;

  SELECT * INTO _cfg FROM public.lead_distribution_config LIMIT 1;
  IF NOT FOUND OR NOT _cfg.is_active THEN RETURN NULL; END IF;

  IF _cfg.working_hours_only
     AND extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 9 AND 19 THEN
    RETURN NULL;  -- the every-minute sweeper picks it up when the window opens
  END IF;

  PERFORM public.assign_one_lead(NEW.id, 'Auto-distribution');
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  -- A distribution fault must NEVER fail a lead intake. AlterCPA and the
  -- webhooks come first: an unassigned lead is recoverable by the sweeper one
  -- minute later, a lead that was never inserted is gone for good.
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION public.trg_orders_auto_distribute() IS
  'AFTER INSERT on orders: assigns a brand-new inbound lead inside the intake transaction. Silently no-ops when the engine is stopped, the row is not a lead, or anything at all goes wrong.';

DROP TRIGGER IF EXISTS trg_orders_auto_distribute ON public.orders;
CREATE TRIGGER trg_orders_auto_distribute
AFTER INSERT ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.trg_orders_auto_distribute();

-- ── 9. The sweeper's schedule ──────────────────────────────────────────────
-- Every minute, and it is cheap: when is_active is false the function returns
-- before touching orders at all. No pg_net — this scheduler calls nothing
-- external, unlike the AlterCPA and MEX jobs.

CREATE EXTENSION IF NOT EXISTS pg_cron;

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'lead-auto-distribute') THEN
    PERFORM cron.unschedule('lead-auto-distribute');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'lead-auto-distribute', '* * * * *',
  $job$SELECT public.distribute_pending_leads(500, false, 'cron');$job$
);

NOTIFY pgrst, 'reload schema';
