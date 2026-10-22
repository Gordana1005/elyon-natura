-- ============================================================================
-- shop_feed — the naturatherapy.mk shop reads the social department's DAY TOTALS
-- (owner Mile, 22.10.2026: "Пораки" on the shop's Overview shows what the social
-- networks sold next to the Meta message-campaign spend; never in the web totals)
--
-- WHAT: one read-only function and one LOGIN role that can execute it and nothing else.
--   shop_feed.social_daily(p_from date, p_to date)
--     one row per Skopje sale_day of insights_sale_rows (the Insights definition — the
--     same rows as the cohort) with source = 'social':
--       orders / value_mkd   in_total AND bucket <> 'returned'  (placed = open + paid;
--                            the owner's basis, the same as the shop's web ROAS —
--                            cancelled / trashed / replacements are outside in_total)
--       paid_mkd             bucket LIKE 'paid%'  (collected)
--       returned_*           bucket = 'returned'
--     Day totals only: no names, phones, sellers or order ids leave the CRM.
--     Window: p_from..p_to, inclusive Skopje days, 1..93 days per call.
--   natura_shop_reader
--     LOGIN, no inheritance, no memberships, read-only by default, 30 s statement
--     timeout, 3 connections; USAGE on shop_feed + EXECUTE on the one function — no
--     table privilege anywhere. Like every login it also reaches what the platform
--     grants PUBLIC (the same functions `anon` already can; listed by the self-test).
--     The password is NOT set here: scripts/set-shop-feed-password.mjs sets it as a
--     SCRAM verifier (the plaintext never reaches the server).
--
-- The mirror image of the shop-side crm_export / elyon_crm_reader
-- (supabase/shop-side/crm_export_tenant2.sql): the shop's hourly cron
-- (/api/cron/meta-spend) copies these rows into its own SocialSalesDaily table.
--
-- Idempotent: the function is replaced, the role created once and its attributes
-- re-asserted, the grants re-applied.
--
-- ROLLBACK (as postgres; removes everything this file created and nothing else —
-- nothing in the CRM depends on it):
--   BEGIN;
--   DROP SCHEMA IF EXISTS shop_feed CASCADE;
--   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'natura_shop_reader';
--   DROP ROLE IF EXISTS natura_shop_reader;
--   COMMIT;
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ── 0. Preconditions: this must be the MK CRM ────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.orders') IS NULL OR to_regclass('public.mex_parcels') IS NULL
     OR to_regprocedure('public.insights_sale_rows(timestamptz, timestamptz, boolean)') IS NULL THEN
    RAISE EXCEPTION 'shop_feed: public.orders / mex_parcels / insights_sale_rows not found — this is not the MK CRM';
  END IF;
  IF to_regclass('public."Order"') IS NOT NULL THEN
    RAISE EXCEPTION 'shop_feed: public."Order" exists — this is the shop, not the CRM. Aborting.';
  END IF;
END
$pre$;

-- ── 1. The schema ────────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS shop_feed;
REVOKE ALL ON SCHEMA shop_feed FROM PUBLIC;
COMMENT ON SCHEMA shop_feed IS
  'Read-only day totals for the naturatherapy.mk shop (owner-approved 22.10.2026): shop_feed.social_daily. Reader: natura_shop_reader (EXECUTE on that one function only). Rollback: DROP SCHEMA shop_feed CASCADE; DROP ROLE natura_shop_reader.';

-- ── 2. The role (the password is set by scripts/set-shop-feed-password.mjs) ──
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'natura_shop_reader') THEN
    CREATE ROLE natura_shop_reader WITH LOGIN NOINHERIT;
  END IF;
END
$role$;

-- Supabase's postgres is not a superuser: naming SUPERUSER/REPLICATION/BYPASSRLS at
-- all is refused. A new role is created without them; the self-test proves it.
ALTER ROLE natura_shop_reader WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3;
ALTER ROLE natura_shop_reader SET default_transaction_read_only = on;
ALTER ROLE natura_shop_reader SET statement_timeout = '30s';
ALTER ROLE natura_shop_reader SET idle_in_transaction_session_timeout = '60s';
COMMENT ON ROLE natura_shop_reader IS
  'naturatherapy.mk shop reader (owner-approved 22.10.2026): USAGE on shop_feed + EXECUTE on shop_feed.social_daily. No table privilege anywhere. Read-only, 30 s timeout, 3 connections.';

-- ── 3. The function ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION shop_feed.social_daily(p_from date, p_to date)
RETURNS TABLE(day date, orders integer, value_mkd bigint, paid_mkd bigint, returned_orders integer, returned_mkd bigint)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path = public, pg_temp
SET "TimeZone" = 'UTC'
AS $fn$
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from OR p_to - p_from > 92 THEN
    RAISE EXCEPTION 'shop_feed.social_daily: a window of 1..93 days is required' USING ERRCODE = '22023';
  END IF;
  -- Skopje midnight of p_from .. the last microsecond of p_to (insights_sale_rows is BETWEEN).
  RETURN QUERY
  SELECT s.sale_day,
         (count(*) FILTER (WHERE s.in_total AND s.bucket <> 'returned'))::integer,
         coalesce(round(sum(s.value_mkd) FILTER (WHERE s.in_total AND s.bucket <> 'returned')), 0)::bigint,
         coalesce(round(sum(s.value_mkd) FILTER (WHERE s.bucket LIKE 'paid%')), 0)::bigint,
         (count(*) FILTER (WHERE s.bucket = 'returned'))::integer,
         coalesce(round(sum(s.value_mkd) FILTER (WHERE s.bucket = 'returned')), 0)::bigint
  FROM public.insights_sale_rows(
         p_from::timestamp AT TIME ZONE 'Europe/Skopje',
         (p_to + 1)::timestamp AT TIME ZONE 'Europe/Skopje' - interval '1 microsecond',
         false) s
  WHERE s.source = 'social'
  GROUP BY s.sale_day
  ORDER BY s.sale_day;
END
$fn$;

COMMENT ON FUNCTION shop_feed.social_daily(date, date) IS
  'Social-department day totals for the naturatherapy.mk shop (20261022150000): insights_sale_rows source social per Skopje sale_day — orders / value_mkd (in_total, not returned), paid_mkd, returned. 1..93 days. natura_shop_reader only.';

-- ── 4. Grants: the reader and nobody else (PUBLIC and the platform roles out) ─
DO $revoke$
DECLARE
  _f   text := 'shop_feed.social_daily(date, date)';
  _who text;
BEGIN
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', _f);
  FOR _who IN
    SELECT DISTINCT r.rolname
    FROM pg_proc p
    CROSS JOIN LATERAL aclexplode(p.proacl) a
    JOIN pg_roles r ON r.oid = a.grantee
    WHERE p.oid = _f::regprocedure
      AND a.grantee <> p.proowner
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I', _f, _who);
  END LOOP;
END
$revoke$;

GRANT USAGE ON SCHEMA shop_feed TO natura_shop_reader;
GRANT EXECUTE ON FUNCTION shop_feed.social_daily(date, date) TO natura_shop_reader;

-- ── 5. Self-test (negative). Any failure raises → the whole file rolls back. ──
DO $selftest$
DECLARE
  _fn   oid := 'shop_feed.social_daily(date, date)'::regprocedure::oid;
  _r    record;
  _bad  text;
BEGIN
  -- 5.1 A plain login: no superpowers, no memberships.
  SELECT * INTO _r FROM pg_roles WHERE rolname = 'natura_shop_reader';
  IF _r.rolsuper OR _r.rolcreaterole OR _r.rolcreatedb OR _r.rolreplication
     OR _r.rolbypassrls OR _r.rolinherit OR NOT _r.rolcanlogin THEN
    RAISE EXCEPTION 'selftest: natura_shop_reader has unexpected attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'natura_shop_reader'::regrole) THEN
    RAISE EXCEPTION 'selftest: natura_shop_reader is a member of another role (would inherit its privileges)';
  END IF;

  -- 5.2 No table privilege: no relation / column ACL names it, nothing in the data
  -- schemas is reachable, and shop_feed holds no relations.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY 1) INTO _bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'natura_shop_reader'::regrole)
     OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                 WHERE att.attrelid = c.oid AND a.grantee = 'natura_shop_reader'::regrole);
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: a table/column grant names natura_shop_reader: %', _bad;
  END IF;
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY 1) INTO _bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname IN ('public', 'auth', 'storage', 'vault', 'shop_feed')
    AND (has_table_privilege('natura_shop_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege('natura_shop_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: natura_shop_reader can reach tables: %', _bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'shop_feed'::regnamespace) THEN
    RAISE EXCEPTION 'selftest: shop_feed must hold functions only';
  END IF;

  -- 5.3 shop_feed: USAGE, no CREATE; exactly one function, executable by the reader
  -- and by nobody else but its owner; no other function grant names the reader.
  IF NOT has_schema_privilege('natura_shop_reader', 'shop_feed', 'USAGE')
     OR has_schema_privilege('natura_shop_reader', 'shop_feed', 'CREATE') THEN
    RAISE EXCEPTION 'selftest: shop_feed schema privileges are wrong for the reader';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'shop_feed'::regnamespace) <> 1
     OR NOT has_function_privilege('natura_shop_reader', _fn, 'EXECUTE') THEN
    RAISE EXCEPTION 'selftest: the reader must execute exactly shop_feed.social_daily';
  END IF;
  SELECT string_agg(DISTINCT coalesce(r.rolname, 'PUBLIC'), ', ') INTO _bad
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE p.oid = _fn
    AND a.grantee <> p.proowner
    AND a.grantee <> 'natura_shop_reader'::regrole;
  IF _bad IS NOT NULL OR (SELECT proacl FROM pg_proc WHERE oid = _fn) IS NULL THEN
    RAISE EXCEPTION 'selftest: others can execute shop_feed.social_daily: %', coalesce(_bad, 'PUBLIC (default ACL)');
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO _bad
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  WHERE a.grantee = 'natura_shop_reader'::regrole
    AND p.oid <> _fn;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: other function grants name the reader: %', _bad;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = _fn AND p.prosecdef AND p.provolatile = 's'
                   AND p.proowner = current_user::regrole) THEN
    RAISE EXCEPTION 'selftest: shop_feed.social_daily is not STABLE SECURITY DEFINER owned by %', current_user;
  END IF;

  -- 5.4 What every login reaches through the platform's PUBLIC grants (not ours —
  -- `anon` can call the same): listed for the operator, never silently accepted.
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY 1) INTO _bad
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prosecdef
    AND has_function_privilege('natura_shop_reader', p.oid, 'EXECUTE');
  IF _bad IS NOT NULL THEN
    RAISE NOTICE 'selftest: note — platform PUBLIC grants (anon has the same) let any login call: %', _bad;
  END IF;
END
$selftest$;

COMMIT;
