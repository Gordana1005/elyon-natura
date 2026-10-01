-- ============================================================================
-- collabBox booking day — for the WHOLE ledger history (owner 01.10.2026, ~19:40)
-- ============================================================================
-- The owner, verbatim: "тоа што е направено порачка вчера, си останува за пресметките во
-- вчерашниот ден, а тоа што е денес потврдено, си е во денешната пресметка … ме интерсира
-- кога е направена порачката, тогаш ги сметиме парите, Simple as that."
--
-- So a collabBox sale counts on the day the operator BOOKED it — always, not only from
-- 01.10. The cutoff collabbox_booking_day_since() moves from 01.10.2026 to the start of the
-- document ledger, 01.03.2026 00:00 Skopje (CET, +01). Every document in collabbox_documents
-- has a decided booked_at (live 'seen', or the document-number 'sequence' estimate, or 'doc'
-- = its own date) since the backfill of 01.10 (run 78e4f09b…). Orders the sync created and
-- credited orders are re-stamped by scripts/backfill-collabbox-booked-at.mjs (ledger-first,
-- rollback by run id). The teleshop history before March 2026 (teleshop_import_documents) has
-- no booking time and keeps its document day.
-- ============================================================================

SET lock_timeout = '10s';

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'collabbox_booking_day_since'
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('f38d66e1cd991f1d826f7b6f442f368d',
                                                                '33fe39d04b74445bc9defdf85e3bf5ed')) THEN
    RAISE EXCEPTION 'collabbox_booking_day_since changed since this migration was written — re-emit it from the live body';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.collabbox_booking_day_since()
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
  SELECT timestamptz '2026-03-01 00:00:00+01';
$fn$;

COMMENT ON FUNCTION public.collabbox_booking_day_since() IS
  'From when a collabBox sale counts on its BOOKING day (collabbox_sale_at): 01.03.2026 00:00 Skopje = the start of the document ledger, i.e. always (owner 01.10.2026: "what was ordered yesterday stays yesterday; what was confirmed today is today"). Was 01.10.2026 (20260944000500). Migration 20260944000620.';

COMMIT;

NOTIFY pgrst, 'reload schema';
