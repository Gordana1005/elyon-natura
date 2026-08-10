-- The TAKE soft-lock must not destroy a manager's assignment.
-- ============================================================================
-- Ported from Elyon BG (2026-08-10), landing their v4 end state in one step —
-- BG reached it across three migrations (20260913000000 → 20260915000000) and
-- this fork has none of that intermediate history to preserve.
--
-- "Take" means: the agent is CURRENTLY viewing this customer on /calls. On the
-- first heartbeat the customer's workable orders flip to 'take' and are stamped
-- with the viewing agent; on release they revert to the recorded prior status.
--
-- BUG (D1/D2/D3): every revert path also wrote assigned_agent_id = NULL.
-- active_call_views recorded only taken_from_status, never the prior ASSIGNEE,
-- so the revert could not tell these two cases apart:
--    a) the take claimed a genuinely unassigned order  -> NULL is correct
--    b) the take was on the agent's OWN assigned lead  -> NULL destroys the
--       manager's assignment
-- Because the take path deliberately allows (b) (an agent must be able to open
-- their own lead), merely LOOKING at an assigned lead and then moving on
-- returned it to the unassigned pool, where it was handed to a different agent.
-- Worse, assigned_agent_name was left behind, so the row still DISPLAYED the old
-- owner while the system treated it as unassigned ("phantom owner") — which is
-- why this stayed invisible for weeks in BG.
--
-- Third bug in the same function: the orphan safety net (step 2) forced every
-- stuck take to 'call_again' without setting call_again_since, and
-- expire_call_again_window() only releases rows WHERE call_again_since IS NOT
-- NULL — so those orders could never return to the calling pool.
--
-- FIX:
--   * active_call_views.taken_from_agent uuid[] records the prior assignee per
--     taken order, parallel to taken_order_ids / taken_from_status.
--   * Reverts restore that assignee (id + name together) instead of NULLing, and
--     match on (recorded id, status='take') — NOT on the taking agent, or a
--     colleague's taken lead sits in 'take' forever, visible to nobody's queue.
--   * The orphan net splits by source: LEADS park in call_again WITH
--     call_again_since; everything else returns to 'pending', because Call Again
--     is a LEAD state (see 20260917000000_pendings_are_leads_only.sql, which must
--     run first — this function calls public.is_lead_source()).
--   * Invariant enforced everywhere: assigned_agent_id / assigned_agent_name /
--     assigned_at move as ONE triple. A NULL id must never leave a name behind.
--
-- ⚠ MK deviation from the BG file: BG ends with
--   `GRANT EXECUTE ... TO authenticated`. We deliberately do NOT. This project
--   revoked that grant in 20260904000300_revoke_anon_maintenance_rpcs.sql
--   because affiliates hold real Supabase logins and can reach PostgREST
--   directly. The edge function calls this RPC through adminClient (service
--   role), so service_role alone is sufficient. Do not "restore" the grant.
--
-- NOTE — no data backfill here, and none is needed. Verified on this database
-- 2026-08-10: 0 orders in 'take', 0 call_again rows with call_again_since NULL,
-- and the only open row with a name-but-no-id is a single legacy import. The
-- 67.069 name-without-id rows overall are ALL terminal-state legacy imports
-- carrying historical attribution — never "repair" those, it would erase who
-- sold and who cancelled across the entire order history.
-- ============================================================================

BEGIN;

ALTER TABLE public.active_call_views
  ADD COLUMN IF NOT EXISTS taken_from_agent uuid[];

COMMENT ON COLUMN public.active_call_views.taken_from_agent IS
  'Prior orders.assigned_agent_id per entry in taken_order_ids (NULL = the order was unassigned when taken). Restored on revert so the take lock never destroys a manager assignment.';

CREATE OR REPLACE FUNCTION public.cleanup_expired_active_call_views()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v RECORD;
  prior_agent uuid;
  prior_name  text;
  reverted_count int := 0;
  orphaned_count int := 0;
  orphaned_leads int := 0;
BEGIN
  -- 1) Expired views: revert their tracked orders to the EXACT prior status and
  --    the EXACT prior assignee (which may be another agent, or nobody).
  FOR v IN
    SELECT id, agent_id, taken_order_ids, taken_from_status, taken_from_agent
    FROM public.active_call_views
    WHERE expires_at < now()
  LOOP
    FOR i IN 1..coalesce(array_length(v.taken_order_ids, 1), 0) LOOP
      -- NULL when the take claimed an unassigned order. Rows written before this
      -- migration have no array at all, which reads as NULL too — so they degrade
      -- to the old "clear the lock" behaviour rather than erroring.
      prior_agent := CASE
        WHEN v.taken_from_agent IS NULL THEN NULL
        ELSE v.taken_from_agent[i]
      END;

      prior_name := NULL;
      IF prior_agent IS NOT NULL THEN
        SELECT p.full_name INTO prior_name
        FROM public.profiles p WHERE p.user_id = prior_agent;
      END IF;

      -- Matching on (recorded id, status='take') is both sufficient and safe:
      -- only ids the expiring view itself recorded are touched, and an order
      -- already in 'take' is never a take candidate, so two agents cannot
      -- collide over one order. Keying on the taking agent instead would strand
      -- a claimed colleague lead in 'take' permanently.
      UPDATE public.orders
        SET status = v.taken_from_status[i]::order_status,
            assigned_agent_id = prior_agent,
            assigned_agent_name = prior_name,
            assigned_at = CASE WHEN prior_agent IS NULL THEN NULL ELSE assigned_at END
        WHERE id = v.taken_order_ids[i]
          AND status = 'take';
      IF FOUND THEN reverted_count := reverted_count + 1; END IF;
    END LOOP;
    DELETE FROM public.active_call_views WHERE id = v.id;
  END LOOP;

  -- 2) SAFETY NET: orders still in 'take' that NO live view covers (agent went
  --    offline / crashed / the take got stuck untracked). Step 1 handled every
  --    one it could still see, so for these there is no record of the prior
  --    status or assignee.
  --
  --    2a) LEADS park in the Call-Again window WITH call_again_since, so
  --        expire_call_again_window() can release them after 6 days. Omitting
  --        that stamp is what froze 14 orders permanently in BG.
  UPDATE public.orders o
    SET status = 'call_again'::order_status,
        call_again_since = coalesce(o.call_again_since, now()),
        assigned_agent_id = NULL,
        assigned_agent_name = NULL,
        assigned_at = NULL
    WHERE o.status = 'take'
      AND public.is_lead_source(o.source_type)
      AND NOT EXISTS (
        SELECT 1 FROM public.active_call_views acv
        WHERE acv.expires_at > now() AND o.id = ANY(acv.taken_order_ids)
      );
  GET DIAGNOSTICS orphaned_leads = ROW_COUNT;

  --    2b) Everything else (prediction-list work, imports) returns to 'pending'.
  --        Call Again is a LEAD state — a prediction customer who was not reached
  --        is a no-answer on their member row, never a call-again order, and must
  --        never surface in anyone's Pendings queue.
  UPDATE public.orders o
    SET status = 'pending'::order_status,
        assigned_agent_id = NULL,
        assigned_agent_name = NULL,
        assigned_at = NULL
    WHERE o.status = 'take'
      AND NOT public.is_lead_source(o.source_type)
      AND NOT EXISTS (
        SELECT 1 FROM public.active_call_views acv
        WHERE acv.expires_at > now() AND o.id = ANY(acv.taken_order_ids)
      );
  GET DIAGNOSTICS orphaned_count = ROW_COUNT;

  RETURN reverted_count + orphaned_leads + orphaned_count;
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_active_call_views() IS
  'take-lock v4-mk (2026-08-10): reverts on (id, status=take) so a taken COLLEAGUE lead is released too, restoring its real owner and name from taken_from_agent. Orphans: leads -> call_again with call_again_since, everything else -> pending. service_role only (see 20260904000300).';

-- Re-assert the lockdown from 20260904000300 — CREATE OR REPLACE preserves
-- existing grants, but state this explicitly so nobody restores the BG grant.
REVOKE ALL ON FUNCTION public.cleanup_expired_active_call_views() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cleanup_expired_active_call_views() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_active_call_views() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
