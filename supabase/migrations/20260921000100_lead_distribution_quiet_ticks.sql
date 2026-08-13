-- Lead distribution: don't log an audit row for doing nothing.
--
-- The sweeper runs every minute. With the engine started and the backlog drained
-- the overwhelmingly common outcome is "there were no leads waiting" — and as
-- first written that inserted a lead_distribution_runs row anyway: 1.440 rows a
-- day, ~525k a year, of pure noise. Worse, it would have buried the handful of
-- rows that actually mean something (an assignment, or a run blocked because
-- every agent was full) under thousands of idle ticks.
--
-- So: a tick that considered nothing and assigned nothing writes NO run row.
-- last_run_at is still stamped, so the config row remains a live "the engine is
-- ticking" heartbeat for the page — and when the engine is stopped the function
-- returns before that, which is exactly why "Last run" freezes on Stop.
--
-- Only the tail of distribute_pending_leads() changes; the picker, the trigger
-- and the schedule are untouched.

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
    -- An idle tick is not history. Record only runs that did something, or that
    -- found work and could not place it — the two cases an operator ever needs
    -- to look back at.
    IF _n > 0 OR _seen > 0 THEN
      INSERT INTO public.lead_distribution_runs (source, assigned, considered, skipped_reason, per_agent)
      VALUES (COALESCE(_source, 'cron'), _n, _seen, _reason, _per);
    END IF;

    -- Always stamped, so the page can show a live heartbeat.
    UPDATE public.lead_distribution_config
       SET last_run_at = now(), last_run_assigned = _n;
  END IF;

  assigned := _n; considered := _seen; skipped_reason := _reason; per_agent := _per;
  RETURN NEXT;
END;
$fn$;

COMMENT ON FUNCTION public.distribute_pending_leads(integer, boolean, text) IS
  'Drains the unassigned inbound-lead pool. Gated on lead_distribution_config.is_active, advisory-locked against the cron, newest-first by default. _dry_run returns the plan without writing and simulates load as it goes. Idle ticks stamp last_run_at but write no run row.';
REVOKE ALL ON FUNCTION public.distribute_pending_leads(integer, boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.distribute_pending_leads(integer, boolean, text) TO service_role;

NOTIFY pgrst, 'reload schema';
