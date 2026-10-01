-- ============================================================================
-- collabBox booking day — the switch-over gap (owner 01.10.2026, ~19:15)
-- ============================================================================
-- The owner saw Телешоп – Lead out at 207 for 01.10 and said that cannot be one day's work.
-- He was right. Three independent read-only checks (people, MEX ground truth, duplicates)
-- found no double counting, but 01.10 held ~1.4 days of sales:
--   A  72 documents DATED 01.10 but BOOKED 16–30.09 — counted on their dispatch day, because
--      collabbox_sale_at() moved a sale to its booking day only when the booking itself was on
--      or after the cutoff (01.10);
--   B  82 booked 01.10 for dispatch 01.10;
--   C  60 booked 01.10 for dispatch 02–09.10 (counted today under the new rule).
-- A + B + C = 214 documents (210 after the twin/skip filters). The owner's rule is "the day
-- the operator BOOKED it", so group A belongs to its September booking days, not to 01.10.
--
-- The fix: a document DISPATCHED on/after the cutoff also counts on its booking day, even when
-- it was booked before the cutoff. Nothing dispatched before 01.10 moves (September's own
-- dispatch days stay as they were); only the ~100 bookings made in late September for
-- October dispatch move back to the September day they were made (group A today, and ~36
-- dated 02.10 and later). TWIN: saleAt() in scripts/lib/collabbox-booking-day.mjs.
-- ============================================================================

SET lock_timeout = '10s';

BEGIN;

DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                 WHERE n.nspname = 'public' AND p.proname = 'collabbox_sale_at'
                   AND md5(replace(p.prosrc, chr(13), '')) IN ('93102c62cfe508831584e342c9af8af8',
                                                                'c532984ef13af110b110c1cfbea07557')) THEN
    RAISE EXCEPTION 'collabbox_sale_at changed since this migration was written — re-emit it from the live body';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.collabbox_sale_at(p_doc_at timestamptz, p_booked_at timestamptz)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $fn$
  SELECT CASE WHEN p_booked_at IS NOT NULL AND p_booked_at < p_doc_at
                   AND (p_booked_at >= public.collabbox_booking_day_since()
                        OR p_doc_at >= public.collabbox_booking_day_since())
              THEN p_booked_at ELSE p_doc_at END;
$fn$;

COMMENT ON FUNCTION public.collabbox_sale_at(timestamptz, timestamptz) IS
  'THE sale time of a collabBox document (owner 01.10.2026: the day the operator booked it): booked_at when it is earlier than doc_at and either the booking or the dispatch day is on/after collabbox_booking_day_since(), else doc_at. Nothing dispatched before the cutoff moves; a booking made before the cutoff for dispatch after it counts on its booking day (the switch-over gap, 20260944000610). Read by the writer, collabbox_booked_today, leaderboard_day_v2, insights_sale_rows, insights_work. TWIN: saleAt() in scripts/lib/collabbox-booking-day.mjs.';

COMMIT;

NOTIFY pgrst, 'reload schema';
