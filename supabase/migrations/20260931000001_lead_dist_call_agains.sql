-- Pending call-agains: second pass of the inbound motor + auto-release when
-- the owner has been offline long enough. Fresh pending still goes first.
-- Trigger stays pending-only (a no-answer does not re-enter INSERT).

ALTER TABLE public.lead_distribution_config
  ADD COLUMN IF NOT EXISTS call_again_offline_release_minutes integer NOT NULL DEFAULT 15;

COMMENT ON COLUMN public.lead_distribution_config.call_again_offline_release_minutes IS
  'Minutes of last_seen staleness before a pending call_again is released to the unassigned pool. 0 disables auto-release. Must be > 2 (the online heartbeat window).';

CREATE INDEX IF NOT EXISTS idx_orders_unassigned_call_again
  ON public.orders (call_again_since ASC NULLS LAST, created_at ASC)
  WHERE assigned_agent_id IS NULL
    AND status = 'call_again'
    AND source_type IN ('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned');

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
  _cfg      public.lead_distribution_config%ROWTYPE;
  _row      record;
  _agent    uuid;
  _n        integer := 0;
  _seen     integer := 0;
  _per      jsonb   := '{}'::jsonb;
  _reason   text    := NULL;
  _released integer := 0;
  _mins     integer;
BEGIN
  assigned := 0; considered := 0; skipped_reason := NULL; per_agent := '{}'::jsonb;

  IF NOT _dry_run AND NOT pg_try_advisory_xact_lock(hashtext('lead_distribution')::bigint) THEN
    skipped_reason := 'already_running';
    RETURN NEXT; RETURN;
  END IF;

  SELECT * INTO _cfg FROM public.lead_distribution_config LIMIT 1;
  IF NOT FOUND THEN
    skipped_reason := 'no_config';
    RETURN NEXT; RETURN;
  END IF;

  IF NOT _cfg.is_active AND NOT _dry_run THEN
    skipped_reason := 'engine_stopped';
    RETURN NEXT; RETURN;
  END IF;

  IF _cfg.working_hours_only
     AND extract(hour FROM now() AT TIME ZONE 'Europe/Skopje') NOT BETWEEN 9 AND 19 THEN
    skipped_reason := 'outside_working_hours';
    RETURN NEXT; RETURN;
  END IF;

  -- Offline owners: release pending call_agains only (never take, never fresh pending).
  _mins := COALESCE(_cfg.call_again_offline_release_minutes, 0);
  IF _mins > 0 AND NOT _dry_run THEN
    WITH gone AS (
      SELECT p.user_id
      FROM public.profiles p
      WHERE (p.last_seen_at IS NULL OR p.last_seen_at < now() - make_interval(mins => _mins))
        AND COALESCE(p.voip_state, 'idle') NOT IN ('dialing', 'in_call', 'wrapping')
    )
    UPDATE public.orders o
       SET assigned_agent_id = NULL,
           assigned_agent_name = NULL,
           assigned_at = NULL,
           assigned_by = NULL
     WHERE o.assigned_agent_id IN (SELECT user_id FROM gone)
       AND o.status = 'call_again'
       AND public.is_lead_source(o.source_type);
    GET DIAGNOSTICS _released = ROW_COUNT;
  END IF;

  -- Pass 1: fresh unassigned pending.
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
      _agent := public.pick_agent_for_lead(_row.id, _per);
    ELSE
      _agent := public.assign_one_lead(_row.id, 'Auto-distribution');
    END IF;
    IF _agent IS NOT NULL THEN
      _n   := _n + 1;
      _per := jsonb_set(_per, ARRAY[_agent::text], to_jsonb(COALESCE((_per ->> _agent::text)::int, 0) + 1));
    END IF;
  END LOOP;

  -- Pass 2: leftover capacity → oldest unassigned pending call_again.
  -- Remaining slot budget is _limit - _seen so a flood of pendings still wins.
  FOR _row IN
    SELECT o.id
    FROM public.orders o
    WHERE o.assigned_agent_id IS NULL
      AND o.status = 'call_again'
      AND public.is_lead_source(o.source_type)
    ORDER BY o.call_again_since ASC NULLS LAST, o.created_at ASC
    LIMIT GREATEST(COALESCE(_limit, 500) - _seen, 0)
  LOOP
    _seen := _seen + 1;
    IF _dry_run THEN
      _agent := public.pick_agent_for_lead(_row.id, _per);
    ELSE
      _agent := public.assign_one_lead(_row.id, 'Auto-distribution');
    END IF;
    IF _agent IS NOT NULL THEN
      _n   := _n + 1;
      _per := jsonb_set(_per, ARRAY[_agent::text], to_jsonb(COALESCE((_per ->> _agent::text)::int, 0) + 1));
    END IF;
  END LOOP;

  IF _seen = 0 AND _released = 0 THEN
    _reason := 'no_leads';
  ELSIF _n = 0 THEN
    _reason := CASE WHEN _released > 0 THEN 'offline_released' ELSE 'no_capacity' END;
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
  'Drains unassigned inbound pending first, then unassigned pending call_again. Optionally releases call_agains whose owner is offline. Gated on is_active.';
REVOKE ALL ON FUNCTION public.distribute_pending_leads(integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_pending_leads(integer, boolean, text) TO service_role;
