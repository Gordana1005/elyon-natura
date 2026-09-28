-- ============================================================================
-- REPORT-EXCLUDED PHONES — the test numbers every report leaves out (2026-09-28)
--
-- Owner decision 28.09.2026 (HANDOFF §3, law):
--   "Test phones 070123456 and 23123123: DELETE their CRM orders (snapshot first).
--    Exclude their web orders and MEX parcels from all reports; you can't touch the shop."
--
-- The CRM orders go with scripts/repair-test-phones.mjs. What stays — the web-shop mirror
-- (web_orders, re-synced from naturatherapy.mk every 15 min, so it cannot be deleted here)
-- and the MEX register (mex_parcels, the courier's own record) — must drop out of every
-- report the SAME way. This migration is that one place:
--
--   public.report_excluded_phones        phone8 (the last 8 digits) + a note. Seeded with the
--                                        two test numbers. Owners read it; only the service
--                                        role / migrations write it.
--   public.is_report_excluded_phone(p)   THE helper. p = a phone in ANY format — E.164
--                                        (+38970123456), national (070123456), 00389…, with
--                                        spaces/dashes, or an 8-digit phone8 column
--                                        (mex_parcels.phone8, web_orders.phone8). True when
--                                        p has at least 8 digits and its last 8 are listed.
--                                        NULL / '' / fewer than 8 digits → false (never
--                                        NULL, so `WHERE NOT is_report_excluded_phone(x)`
--                                        never drops a row by accident).
--   public.report_excluded_phone8s()     the listed phone8 values as text[] — the set-based
--                                        form for a big scan (see USAGE).
--
-- Matching is the project's last-8 canon (.grok/skills/elyon-phone-normalization) with the
-- exact expression idx_orders_phone_last8 indexes:
--     right(regexp_replace(<phone>, '[^0-9]', '', 'g'), 8)
--
-- USAGE (every report, one of):
--   per row      WHERE NOT public.is_report_excluded_phone(o.customer_phone)
--                WHERE NOT public.is_report_excluded_phone(p.phone8)        -- mex_parcels
--                WHERE NOT public.is_report_excluded_phone(w.phone8)        -- web_orders
--   set-based    WHERE NOT (right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8)
--                           = ANY ((SELECT public.report_excluded_phone8s())::text[]))
--                (the scalar sub-select runs once per statement — an InitPlan — instead of
--                 once per row; use it in the 100k-row scans of the Insights cohort. The
--                 ::text[] is required: without it ANY(<sub-select>) compares against each ROW
--                 of the sub-select, i.e. text = text[], and fails)
--
-- Contract for the Insights cohort (migration 20260940000000) and any later report: the
-- name and signature public.is_report_excluded_phone(text) → boolean are FIXED. Adding a
-- phone is one INSERT here (a migration), never a code change.
--
-- ORDER OF APPLICATION: a LANGUAGE sql function body is validated at CREATE time, so a
-- migration whose SQL functions call is_report_excluded_phone() must be applied AFTER this
-- one (plpgsql bodies are not validated). This file creates no dependency on anything newer
-- than 20260934000000 (is_business_owner) and can go first.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The list ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.report_excluded_phones (
  phone8     text PRIMARY KEY
             CONSTRAINT report_excluded_phones_phone8_check CHECK (phone8 ~ '^[0-9]{8}$'),
  note       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.report_excluded_phones IS
  'Phones every report leaves out (owner decision 2026-09-28: the test numbers 070123456 and 23123123). Keyed by phone8 = the last 8 digits (the CRM matching canon). Their CRM orders are deleted by scripts/repair-test-phones.mjs; their web_orders and mex_parcels stay and are excluded via public.is_report_excluded_phone(text). Owners read it; service role writes.';
COMMENT ON COLUMN public.report_excluded_phones.phone8 IS
  'Last 8 digits of the phone: right(regexp_replace(phone, ''[^0-9]'', '''', ''g''), 8) — the expression idx_orders_phone_last8 indexes.';

INSERT INTO public.report_excluded_phones (phone8, note) VALUES
  ('70123456', 'Test phone 070123456 — owner decision 28.09.2026: its CRM orders are deleted (scripts/repair-test-phones.mjs), its web orders and MEX parcels are excluded from every report.'),
  ('23123123', 'Test phone 23123123 — owner decision 28.09.2026: its CRM orders are deleted (scripts/repair-test-phones.mjs), its web orders and MEX parcels are excluded from every report.')
ON CONFLICT (phone8) DO NOTHING;

-- Owners only (the business_owners pattern, 20260934000000). Scalar sub-select: evaluated
-- once per statement. No write policies — service role / migrations only.
ALTER TABLE public.report_excluded_phones ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS report_excluded_phones_select_owners ON public.report_excluded_phones;
CREATE POLICY report_excluded_phones_select_owners ON public.report_excluded_phones
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

REVOKE ALL ON public.report_excluded_phones FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.report_excluded_phones TO authenticated;
GRANT ALL ON public.report_excluded_phones TO service_role;

-- ── 2. The helpers ──────────────────────────────────────────────────────────
-- SECURITY DEFINER on purpose: the exclusion must be identical for every caller. Under the
-- owners-only policy a non-owner (a manager's report, a SECURITY INVOKER view) would read an
-- empty list and silently count the test phones again. The helpers only ever answer
-- "is this phone listed" — no row of the table leaves them.
CREATE OR REPLACE FUNCTION public.is_report_excluded_phone(p_phone text)
RETURNS boolean
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT CASE
           WHEN length(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g')) < 8 THEN false
           ELSE EXISTS (
                  SELECT 1 FROM public.report_excluded_phones x
                   WHERE x.phone8 = right(regexp_replace(p_phone, '[^0-9]', '', 'g'), 8))
         END;
$fn$;

COMMENT ON FUNCTION public.is_report_excluded_phone(text) IS
  'THE report exclusion (owner decision 2026-09-28, test phones): true when the phone — any format, or an 8-digit phone8 — has at least 8 digits and its last 8 are in public.report_excluded_phones. Never NULL. Fixed contract: every report (orders, web_orders, mex_parcels) filters WHERE NOT is_report_excluded_phone(<phone>). Set-based twin: report_excluded_phone8s(). Migration 20260939000700.';

CREATE OR REPLACE FUNCTION public.report_excluded_phone8s()
RETURNS text[]
LANGUAGE sql
STABLE
PARALLEL SAFE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce(array_agg(x.phone8 ORDER BY x.phone8), ARRAY[]::text[]) FROM public.report_excluded_phones x;
$fn$;

COMMENT ON FUNCTION public.report_excluded_phone8s() IS
  'The phone8 values of public.report_excluded_phones as text[] — for big scans: WHERE NOT (right(regexp_replace(phone, ''[^0-9]'', '''', ''g''), 8) = ANY ((SELECT public.report_excluded_phone8s())::text[])), evaluated once per statement (the ::text[] cast is required). Same list as is_report_excluded_phone(text). Migration 20260939000700.';

REVOKE ALL ON FUNCTION public.is_report_excluded_phone(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.report_excluded_phone8s() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_report_excluded_phone(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.report_excluded_phone8s() TO authenticated, service_role;

-- The read-only verification harness (scripts/verify-attribution.mjs) runs as
-- supabase_read_only_user through the Management API. Conditional so a fresh local database
-- without the platform role still migrates (the 20260936000000 pattern).
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.is_report_excluded_phone(text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.report_excluded_phone8s() TO supabase_read_only_user;
    GRANT SELECT ON public.report_excluded_phones TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
