-- Pendings means INBOUND LEADS. Call Again is a lead state, not a call outcome.
-- ============================================================================
-- Ported from Elyon BG (20260914000000_pendings_are_leads_only.sql, 2026-08-10),
-- adapted to the Macedonian source vocabulary. Read docs/LEADS_PORT_GUIDE_MK.md
-- for the full incident; the short version is D6 + D7:
--
--   * A client from a PREDICTION LIST who doesn't answer is simply a NO ANSWER.
--     The member row carries the cooldown and `last_call_outcome='no_answer'`;
--     their ORDER must NOT be moved to `call_again`.
--   * A LEAD (AlterCPA / webhook / website) that doesn't answer DOES go to
--     `call_again`: it is an unsettled inbound order and we keep ringing it.
--
--   * assigned_pending_counts() drives the Assigner's per-agent pendings chip.
--     It counted status='pending' alone while agent_workloads().orders_open
--     counted pending|take|call_again, so a lead that had been called once was
--     in NEITHER the unassigned pool NOR the per-agent chip — invisible work.
--
-- ⚠ MACEDONIA DIFFERS FROM BULGARIA HERE. Verified against this database on
-- 2026-08-10 (906 open rows):
--     source_type='altercpa'  863 pending   ← the lead pool (100% sidecar-linked)
--     source_type='import'     42 open      ← AlterCPA leads relabelled by
--                                             20260917000200; 80.360 rows overall
-- BG's lead value is 'affiliate' and its bulk import is 'monadon_legacy'. Here
-- the lead value is **'altercpa'** and the bulk import is **'import'**.
-- `import` must NEVER be a lead source: it is 80k rows of legacy history and
-- would flood every agent's Pendings queue.
-- `affiliate_leads` is EMPTY here (0 rows) — the partner sidecar is
-- `altercpa_leads` (2.224 rows). See .grok/skills/elyon-altercpa-bridge.
-- ============================================================================

BEGIN;

-- The one definition of "an inbound lead", mirroring LEAD_SOURCE_TYPES in
-- supabase/functions/api/index.ts. Everything else on `orders` is agent-created
-- ('manual', which includes every record produced while working a prediction
-- list), the historical bulk import ('import'), the legacy 'prediction_lead'
-- bridge, or another company's revenue ('monadon_legacy').
CREATE OR REPLACE FUNCTION public.is_lead_source(_source text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT coalesce(_source, '') IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned');
$$;
COMMENT ON FUNCTION public.is_lead_source(text) IS
  'True for order sources that arrived from outside (the agents Pendings queue). MK values — altercpa is this markets lead source, NOT affiliate. Keep in sync with LEAD_SOURCE_TYPES in the api edge function.';

-- The Assigner's pendings chip must mean exactly what the agent's queue shows:
-- inbound leads still in the lifecycle. Counting every source pulled the
-- prediction-list work in and made the number unusable.
CREATE INDEX IF NOT EXISTS idx_orders_assigned_lead_pendings
  ON public.orders (assigned_agent_id)
  WHERE assigned_agent_id IS NOT NULL
    AND status IN ('pending', 'take', 'call_again')
    AND source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned');

CREATE OR REPLACE FUNCTION public.assigned_pending_counts()
RETURNS TABLE (
  agent_id uuid,
  pendings int
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT assigned_agent_id AS agent_id,
         COUNT(*)::int     AS pendings
  FROM public.orders
  WHERE status IN ('pending', 'take', 'call_again')
    AND source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')
    AND assigned_agent_id IS NOT NULL
  GROUP BY assigned_agent_id;
$$;
COMMENT ON FUNCTION public.assigned_pending_counts() IS
  'Per-agent count of assigned INBOUND LEADS still in the lifecycle (pending|take|call_again). Matches the /calls Pendings queue exactly — same statuses, same sources. Widened 2026-08-10; counting pending alone hid every lead that had been called once.';

-- The literal source list is repeated in the index and the function body on
-- purpose: a partial index predicate must be IMMUTABLE and inlining
-- is_lead_source() there would tie the index to the function body, so any later
-- edit to the source list would silently invalidate the index. If you change the
-- list, change it in THREE places: here, the index above, and LEAD_SOURCE_TYPES
-- in the edge function.

REVOKE ALL ON FUNCTION public.assigned_pending_counts() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assigned_pending_counts() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.assigned_pending_counts() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
