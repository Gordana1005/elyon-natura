-- ============================================================================
-- AlterCPA sweeps that finish: resumable nightly / weekly sweeps (2026-09-28)
-- ============================================================================
-- WHY. The nightly (7-day) and weekly (90-day) sweeps of the altercpa-sync
-- edge function have not finished once since 18.09. Every run row ends
-- "stale: still running after 10 minutes": the function spends ~88 ms of DB
-- round-trips per lead (+ ~0.5 s fixed), so a 7-day window no longer fits the
-- edge wall clock (~150 s) and the 90-day one never did. The function is
-- killed before it writes the run's end, and the next invocation's
-- housekeeping marks the row failed. integrations_health() (20260939000200)
-- shows the nightly's last ok on 08-09.
--
-- WHAT. A sweep becomes a row that outlives any one invocation:
--   altercpa_sweeps                   one row per sweep: its FIXED window
--                                     (AlterCPA creation time, both ends
--                                     inclusive), a cursor (every lead created
--                                     before cursor_at is written), a lease, and
--                                     how it ended: done · superseded · expired
--                                     · failed
--   altercpa_sync_runs.sweep_id       each invocation still writes ONE run row
--                                     (kind nightly/weekly, window = the span it
--                                     wrote); it ends ok once its chunks are
--                                     written, while the sweep goes on
--   altercpa_sweep_claim(…)           open-or-continue, then lease — atomically
--   altercpa_sweep_advance(…)         move the cursor: the lease holder only,
--                                     forward only; past window_to = done
--   altercpa_sweep_release(…)         end of an invocation: drop the lease (after
--                                     a failure: keep the sweep paused 5 min)
--   altercpa_sweeps_close_stale(…)    close what is past its limits, each with a
--                                     FAILED run row that says why
--   invoke_altercpa_sweep_continue()  + pg_cron 'altercpa-sync-continue', every
--                                     2 min on the odd minutes: a cheap no-op
--                                     unless a sweep is open AND unleased — then
--                                     it POSTs {kind:'continue'} through
--                                     invoke_altercpa_sync(), exactly like the
--                                     other altercpa-sync jobs
-- The edge function works a sweep in day chunks, stopping new work 100 s into
-- an invocation, with the per-lead reads batched per page of 100 and a cursor
-- checkpoint after every page (supabase/functions/altercpa-sync/sweep.ts).
--
-- NOT CHANGED. altercpa-sync-nightly (15 1 * * *) and altercpa-sync-weekly
-- (45 2 * * 0) keep their schedules and their call; they now OPEN a sweep.
-- altercpa-sync-rolling and altercpa-sync-status are untouched, and so are
-- import_scope, the B′ outcome map and every money guard (all edge-function
-- code, shared unchanged with rolling).
--
-- RULES
--   * One open sweep per account (uq_altercpa_sweeps_open). A start while one
--     is open continues THAT sweep (the start is absorbed) — except a WEEKLY
--     start meeting an open NIGHTLY: the nightly closes 'superseded' and the
--     weekly opens, since its 90 days contain the rest of the nightly's 7.
--   * A slice in flight holds the lease (240 s); nobody else works that sweep,
--     and a slice whose lease is gone can no longer move the cursor. A killed
--     slice is retried from the cursor once its lease runs out.
--   * An open sweep always ends: 'expired' 20 h after it opened, or 'failed'
--     after 8 claims in a row that moved nothing. Both write a FAILED run row
--     (kind = the sweep's) whose error names the reason, the cursor and the
--     last error — integrations_health() shows the job failing, with the why.
--   * integrations_health() and the Overview freshness need no change. The
--     Overview (20260936000000) reads only kinds rolling + status.
--     integrations_health reads nightly/weekly by kind and status: every slice
--     row is ok, or failed with a reason; a slice killed mid-flight reads as
--     'running' and then hung after 15 min, as before.
--
-- APPLY:  node scripts/assert-mk-target.mjs
--         node scripts/apply-migration-mk.mjs supabase/migrations/20260940000100_altercpa_sweep_resume.sql
--         npx supabase functions deploy altercpa-sync --project-ref bmfxhgznttcnnlqloqzp
-- Either order is safe. Migration first: no sweep row exists until the new
-- function opens one, so the new cron stays a no-op and the old function runs
-- its old one-shot sweeps. Function first: a nightly/weekly start fails at the
-- claim and leaves a failed run row that says so; rolling and status are
-- unaffected. Idempotent: a re-run changes nothing.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The sweeps ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.altercpa_sweeps (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid        NOT NULL REFERENCES public.altercpa_accounts(id) ON DELETE CASCADE,
  kind          text        NOT NULL CHECK (kind IN ('nightly', 'weekly')),
  -- AlterCPA creation time, both ends inclusive (their from/to are). Fixed at
  -- open: a sweep that finishes late still covers exactly this window.
  window_from   timestamptz NOT NULL,
  window_to     timestamptz NOT NULL,
  -- Every lead created before cursor_at is written. Forward only.
  cursor_at     timestamptz NOT NULL,
  status        text        NOT NULL DEFAULT 'open'
                CHECK (status IN ('open', 'done', 'superseded', 'expired', 'failed')),
  claims        integer     NOT NULL DEFAULT 0,   -- invocations that worked on it
  stalled       integer     NOT NULL DEFAULT 0,   -- claims in a row that moved nothing
  lease_token   uuid,                             -- the invocation working it now
  lease_until   timestamptz,                      -- …until then (or a failure pause)
  last_error    text,                             -- since the last progress
  opened_at     timestamptz NOT NULL DEFAULT now(),
  progressed_at timestamptz,
  closed_at     timestamptz,
  close_reason  text,
  CONSTRAINT altercpa_sweeps_window_check CHECK (window_to >= window_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_altercpa_sweeps_open
  ON public.altercpa_sweeps (account_id) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_altercpa_sweeps_recent
  ON public.altercpa_sweeps (account_id, opened_at DESC);

COMMENT ON TABLE public.altercpa_sweeps IS
  '2026-09-28: one row per AlterCPA nightly/weekly sweep, worked in day chunks across as many altercpa-sync invocations as it needs (cursor + lease). Each invocation writes its own altercpa_sync_runs row (sweep_id). Written only through altercpa_sweep_claim / _advance / _release and altercpa_sweeps_close_stale.';
COMMENT ON COLUMN public.altercpa_sweeps.cursor_at IS
  'Every lead created (AlterCPA time) before this is written; the next chunk starts here. Moves forward only, and only for the lease holder.';

-- Admin/manager read, like altercpa_sync_runs. Nothing writes it but the
-- service role (the edge function) and the SECURITY DEFINER functions below.
ALTER TABLE public.altercpa_sweeps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS altercpa_sweeps_select ON public.altercpa_sweeps;
CREATE POLICY altercpa_sweeps_select ON public.altercpa_sweeps
  FOR SELECT TO authenticated
  USING ((SELECT public.is_admin_or_manager(auth.uid())));
REVOKE ALL ON public.altercpa_sweeps FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.altercpa_sweeps TO authenticated;
GRANT ALL    ON public.altercpa_sweeps TO service_role;

-- ── 2. Run rows know their sweep ────────────────────────────────────────────
-- Nullable, no default: catalog-only on a table the edge function writes all
-- day. Rolling / status / backfill / manual rows keep it NULL.
ALTER TABLE public.altercpa_sync_runs
  ADD COLUMN IF NOT EXISTS sweep_id uuid REFERENCES public.altercpa_sweeps(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_altercpa_sync_runs_sweep
  ON public.altercpa_sync_runs (sweep_id) WHERE sweep_id IS NOT NULL;

-- ── 3. Close what is past its limits ────────────────────────────────────────
-- 'expired': open longer than p_max_age — even with a slice in flight, which
--            is then fenced (its next advance finds the sweep closed).
-- 'failed':  p_max_stalled claims in a row moved nothing (a deterministic error,
--            an API that stays down) — once no slice is in flight or pausing.
-- Each close writes a FAILED run row, kind = the sweep's, window = what was
-- left, so integrations_health() flips the job to failing with the reason.
-- Called by the continuation cron every tick (in SQL: it works even while the
-- edge function is broken) and by altercpa_sweep_claim for its account.
CREATE OR REPLACE FUNCTION public.altercpa_sweeps_close_stale(
  p_account_id  uuid     DEFAULT NULL,                -- NULL = every account
  p_max_age     interval DEFAULT interval '20 hours',
  p_max_stalled integer  DEFAULT 8
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _n integer;
BEGIN
  WITH closed AS (
    UPDATE public.altercpa_sweeps s
       SET status       = CASE WHEN s.opened_at < now() - p_max_age THEN 'expired' ELSE 'failed' END,
           close_reason = CASE WHEN s.opened_at < now() - p_max_age
                            THEN format('expired: still open %s h after it opened', round((extract(epoch FROM now() - s.opened_at) / 3600)::numeric, 1))
                            ELSE format('gave up: %s claims in a row moved nothing', s.stalled)
                          END
                          || format('; %s of %s days written, cursor %s UTC',
                                    round((extract(epoch FROM least(s.cursor_at, s.window_to) - s.window_from) / 86400)::numeric, 1),
                                    round((extract(epoch FROM s.window_to - s.window_from) / 86400)::numeric, 1),
                                    to_char(s.cursor_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'))
                          || coalesce(' — last error: ' || left(s.last_error, 300), ''),
           closed_at    = now(),
           lease_token  = NULL,
           lease_until  = NULL
     WHERE s.status = 'open'
       AND (p_account_id IS NULL OR s.account_id = p_account_id)
       AND (s.opened_at < now() - p_max_age
            OR (s.stalled >= p_max_stalled AND (s.lease_until IS NULL OR s.lease_until <= now())))
    RETURNING s.*
  )
  INSERT INTO public.altercpa_sync_runs
    (account_id, kind, sweep_id, window_from, window_to, status, error, started_at, finished_at, duration_ms)
  SELECT c.account_id, c.kind, c.id, least(c.cursor_at, c.window_to), c.window_to, 'failed',
         c.kind || ' sweep ' || c.close_reason, now(), now(), 0
    FROM closed c;
  GET DIAGNOSTICS _n = ROW_COUNT;
  RETURN _n;
END;
$fn$;

-- ── 4. Claim: open-or-continue, then lease ──────────────────────────────────
-- One call per account per invocation. p_open = a START (the nightly/weekly
-- cron, or an admin): opens a sweep over [p_window_from, p_window_to] when
-- none is open. p_open = false (kind 'continue'): never opens anything.
-- Returns {claimed: true, opened, sweep: <row incl. lease_token>, closed} or
-- {claimed: false, reason: no_open_sweep | busy | paused, closed}.
CREATE OR REPLACE FUNCTION public.altercpa_sweep_claim(
  p_account_id    uuid,
  p_kind          text,           -- nightly | weekly for a start; NULL for a continue
  p_open          boolean,
  p_window_from   timestamptz,    -- a new sweep's window; ignored when one is open
  p_window_to     timestamptz,
  p_lease_seconds integer DEFAULT 240
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _s      public.altercpa_sweeps%ROWTYPE;
  _have   boolean;
  _opened boolean := false;
  _stale  integer;
  _closed jsonb := '[]'::jsonb;
BEGIN
  IF coalesce(p_open, false) AND coalesce(p_kind, '') NOT IN ('nightly', 'weekly') THEN
    RAISE EXCEPTION 'altercpa_sweep_claim: kind % cannot open a sweep', coalesce(p_kind, 'NULL');
  END IF;

  -- Past its limits → closed first: nothing continues a sweep that is over.
  _stale := public.altercpa_sweeps_close_stale(p_account_id);

  SELECT * INTO _s FROM public.altercpa_sweeps
   WHERE account_id = p_account_id AND status = 'open'
   FOR UPDATE;
  _have := FOUND;

  -- A weekly start supersedes an open nightly (its 90 days contain the rest of
  -- the nightly's 7). A nightly slice still in flight is fenced: its next
  -- advance finds the sweep closed and stops.
  IF _have AND coalesce(p_open, false) AND p_kind = 'weekly' AND _s.kind = 'nightly' THEN
    UPDATE public.altercpa_sweeps
       SET status       = 'superseded',
           close_reason = 'superseded by a weekly sweep — its 90 days contain the rest of this window',
           closed_at    = now(),
           lease_token  = NULL,
           lease_until  = NULL
     WHERE id = _s.id;
    _closed := _closed || jsonb_build_array(jsonb_build_object('id', _s.id, 'kind', _s.kind, 'status', 'superseded'));
    _have := false;
  END IF;

  IF NOT _have THEN
    IF NOT coalesce(p_open, false) THEN
      RETURN jsonb_build_object('claimed', false, 'reason', 'no_open_sweep', 'closed', _closed, 'closed_stale', _stale);
    END IF;
    IF p_window_from IS NULL OR p_window_to IS NULL OR p_window_to < p_window_from THEN
      RAISE EXCEPTION 'altercpa_sweep_claim: empty window % → %', p_window_from, p_window_to;
    END IF;
    BEGIN
      INSERT INTO public.altercpa_sweeps (account_id, kind, window_from, window_to, cursor_at)
      VALUES (p_account_id, p_kind, p_window_from, p_window_to, p_window_from)
      RETURNING * INTO _s;
      _opened := true;
    EXCEPTION WHEN unique_violation THEN
      -- A concurrent start opened one first: that sweep is the one.
      SELECT * INTO _s FROM public.altercpa_sweeps
       WHERE account_id = p_account_id AND status = 'open'
       FOR UPDATE;
      IF NOT FOUND THEN
        RETURN jsonb_build_object('claimed', false, 'reason', 'no_open_sweep', 'closed', _closed, 'closed_stale', _stale);
      END IF;
    END;
  END IF;

  -- A slice in flight holds a token; a failed slice leaves a pause without one.
  IF _s.lease_until IS NOT NULL AND _s.lease_until > now() THEN
    RETURN jsonb_build_object(
      'claimed', false,
      'reason',  CASE WHEN _s.lease_token IS NULL THEN 'paused' ELSE 'busy' END,
      'closed',  _closed, 'closed_stale', _stale,
      'sweep',   to_jsonb(_s) - 'lease_token');
  END IF;

  UPDATE public.altercpa_sweeps
     SET lease_token = gen_random_uuid(),
         lease_until = now() + make_interval(secs => greatest(coalesce(p_lease_seconds, 240), 30)),
         claims      = claims + 1,
         stalled     = stalled + 1      -- reset by the first advance that moves the cursor
   WHERE id = _s.id
  RETURNING * INTO _s;

  RETURN jsonb_build_object('claimed', true, 'opened', _opened, 'closed', _closed,
                            'closed_stale', _stale, 'sweep', to_jsonb(_s));
END;
$fn$;

-- ── 5. Advance: the lease holder moves the cursor ───────────────────────────
-- Forward only (greatest). Returns 'open', 'done' (the cursor passed
-- window_to: closed and unleased in the same statement) or 'lost' (not the
-- lease holder any more, or the sweep was closed meanwhile — stop).
CREATE OR REPLACE FUNCTION public.altercpa_sweep_advance(
  p_sweep_id uuid,
  p_token    uuid,
  p_cursor   timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _status text;
BEGIN
  UPDATE public.altercpa_sweeps s
     SET cursor_at     = greatest(s.cursor_at, p_cursor),
         progressed_at = CASE WHEN p_cursor > s.cursor_at THEN now() ELSE s.progressed_at END,
         stalled       = CASE WHEN p_cursor > s.cursor_at THEN 0 ELSE s.stalled END,
         last_error    = CASE WHEN p_cursor > s.cursor_at THEN NULL ELSE s.last_error END,
         status        = CASE WHEN greatest(s.cursor_at, p_cursor) > s.window_to THEN 'done' ELSE s.status END,
         closed_at     = CASE WHEN greatest(s.cursor_at, p_cursor) > s.window_to THEN now() ELSE s.closed_at END,
         close_reason  = CASE WHEN greatest(s.cursor_at, p_cursor) > s.window_to THEN 'complete' ELSE s.close_reason END,
         lease_token   = CASE WHEN greatest(s.cursor_at, p_cursor) > s.window_to THEN NULL ELSE s.lease_token END,
         lease_until   = CASE WHEN greatest(s.cursor_at, p_cursor) > s.window_to THEN NULL ELSE s.lease_until END
   WHERE s.id = p_sweep_id
     AND s.status = 'open'
     AND s.lease_token = p_token
  RETURNING s.status INTO _status;
  RETURN coalesce(_status, 'lost');
END;
$fn$;

-- ── 6. Release: the end of an invocation ────────────────────────────────────
-- Drops the lease so the next continuation tick can claim at once. After a
-- failure the edge function passes the error and a pause: the sweep keeps a
-- lease with no token until then, so a failing API is retried, not hammered.
CREATE OR REPLACE FUNCTION public.altercpa_sweep_release(
  p_sweep_id            uuid,
  p_token               uuid,
  p_error               text    DEFAULT NULL,
  p_retry_after_seconds integer DEFAULT 0
)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  UPDATE public.altercpa_sweeps
     SET lease_token = NULL,
         lease_until = CASE WHEN coalesce(p_retry_after_seconds, 0) > 0
                            THEN now() + make_interval(secs => p_retry_after_seconds) END,
         last_error  = coalesce(left(p_error, 1000), last_error)
   WHERE id = p_sweep_id
     AND lease_token = p_token
     AND status = 'open';
$fn$;

-- ── 7. The continuation job ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.invoke_altercpa_sweep_continue()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  -- In SQL, so a stale sweep closes (with its failed run row) even while the
  -- edge function itself is broken or undeployed.
  PERFORM public.altercpa_sweeps_close_stale();

  -- The cheap gate: nothing open that a slice could work on right now — none
  -- open, or the lease says a slice is in flight / pausing → no HTTP at all.
  -- This is the job's state for most of the day.
  IF NOT EXISTS (
    SELECT 1
      FROM public.altercpa_sweeps s
      JOIN public.altercpa_accounts a ON a.id = s.account_id AND a.is_active
     WHERE s.status = 'open'
       AND (s.lease_until IS NULL OR s.lease_until <= now())
  ) THEN
    RETURN;
  END IF;

  -- The same wrapper as every altercpa-sync job: Vault secret, the hardcoded
  -- MACEDONIA project URL, fail-silent.
  PERFORM public.invoke_altercpa_sync('continue');
EXCEPTION WHEN OTHERS THEN
  RETURN;  -- the scheduler must never error the cron job
END;
$fn$;

REVOKE ALL ON FUNCTION public.altercpa_sweeps_close_stale(uuid, interval, integer)                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_sweep_claim(uuid, text, boolean, timestamptz, timestamptz, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_sweep_advance(uuid, uuid, timestamptz)                             FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.altercpa_sweep_release(uuid, uuid, text, integer)                           FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.invoke_altercpa_sweep_continue()                                            FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.altercpa_sweeps_close_stale(uuid, interval, integer)                        TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_sweep_claim(uuid, text, boolean, timestamptz, timestamptz, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_sweep_advance(uuid, uuid, timestamptz)                             TO service_role;
GRANT EXECUTE ON FUNCTION public.altercpa_sweep_release(uuid, uuid, text, integer)                           TO service_role;

-- Idempotent: replace any previous schedule with this name.
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'altercpa-sync-continue') THEN
    PERFORM cron.unschedule('altercpa-sync-continue');
  END IF;
END
$cron$;

-- Every 2 minutes on the odd minutes (the even ones are altercpa-sync-
-- rolling's). A slice stops new work at 100 s and releases its lease, so the
-- next tick claims again: ~100 s of work per 2 minutes until the sweep is
-- done. Outside a sweep this is one EXISTS on a table of a row a day.
SELECT cron.schedule(
  'altercpa-sync-continue', '1-59/2 * * * *',
  $job$SELECT public.invoke_altercpa_sweep_continue();$job$
);

NOTIFY pgrst, 'reload schema';
