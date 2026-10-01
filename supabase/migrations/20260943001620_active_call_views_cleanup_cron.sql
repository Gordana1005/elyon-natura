-- ============================================================================
-- "Who is viewing" — the expired-view sweep moves from READS to a cron job
-- (Phase 11 A, 01.10.2026).
--
-- Until now public.cleanup_expired_active_call_views() (take-lock v4-mk,
-- 20260917000100) ran at the start of every GET /active-call-views/lookup. The
-- /orders list asked that once PER ROW every 30 s — 20 requests per page, each
-- a write before the read (median 568 ms). The list now reads a whole page in
-- one GET /active-views?phones=…, and neither read writes: both filter
-- expires_at > now(), so an expired view is never SHOWN even before it is swept.
--
-- The sweep still has to happen (it restores the prior status and assignee of
-- a 'take' whose agent went quiet, and parks orphans), and no cron did it —
-- only reads and heartbeats. So: once a minute. A view expires 2 minutes after
-- its last heartbeat, so a stale 'take' is released within ≤ 3 minutes, as
-- before. The function is a no-op when nothing expired (two indexed UPDATEs on
-- status = 'take'). POST /active-call-views/heartbeat and the admin-only
-- GET /active-call-views keep their own sweep.
--
-- Rollback:  SELECT cron.unschedule('active-call-views-cleanup');
-- ============================================================================

SELECT cron.unschedule('active-call-views-cleanup')
 WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'active-call-views-cleanup');
SELECT cron.schedule('active-call-views-cleanup', '* * * * *', $$SELECT public.cleanup_expired_active_call_views();$$);
