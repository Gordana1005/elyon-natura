-- ============================================================================
-- SHOP-SIDE DDL — naturatherapy.mk (tenant 2) read-only export for the Elyon CRM
--
-- ▶ The export imposes NO dependency on any shop column: it is late-bound
--   PL/pgSQL (bodies record nothing in pg_depend), so a shop schema change can
--   only ever make OUR call fail loudly — it can never block the shop's deploy.
--
--   TARGET: the SHOP's Supabase database, project kctgthpoeysmhmkrnkil.
--   NEVER the CRM (bmfxhgznttcnnlqloqzp) and NEVER live Bulgaria
--   (sxymaloycddnoxudxaqp). Apply ONLY through
--       node scripts/apply-shop-crm-export.mjs --apply
--   which refuses any other target, checks that this file touches nothing but
--   the crm_export schema and the elyon_crm_reader role, sets the password as
--   a SCRAM verifier (the plaintext never reaches the server or its logs), and
--   then proves the isolation by logging in AS the reader.
--
-- APPROVAL (Mile, 2026-09-27 — the ONLY change allowed on the live shop): a
-- schema crm_export exposing tenant-2 orders and order lines read-only, and a
-- LOGIN role elyon_crm_reader that can read that export and nothing else.
-- Delivered as FUNCTIONS instead of views (coordinator, 2026-09-28): a view
-- pins the columns it selects, so a future shop `prisma db push` that drops or
-- retypes one of them would FAIL until the view was removed — an effect on the
-- live web. A PL/pgSQL body is only parsed when it runs, so nothing here pins
-- anything. The self-test below PROVES it (zero pg_depend rows from these
-- functions to any table or column). No shop code, settings, tenants, rows,
-- indexes or deploys change.
--
-- WHY A SEPARATE SCHEMA: the shop manages `public` with `prisma db push`,
-- which drops objects in `public` it does not know about. It never looks at
-- other schemas, so crm_export survives every shop deploy.
--
-- The export (all STABLE, SECURITY DEFINER, owned by the applying role,
-- search_path pinned to pg_catalog, pg_temp, TimeZone pinned to UTC so the
-- UTC conversions stay exact even if the shop later moves a column to
-- timestamptz; every shop table fully qualified):
--   crm_export.mk_orders(p_updated_after, p_after_id, p_limit)
--        tenant-2 orders with (updatedAt, id) > (p_updated_after, p_after_id),
--        ordered by (updatedAt, id) — the incremental feed
--   crm_export.mk_orders_by_id(p_after_id, p_limit)
--        tenant-2 orders with id > p_after_id, ordered by id — the full sweep
--        (keyset on the primary key, resumable across calls)
--   crm_export.mk_order_items(p_order_ids)
--        the lines of those ids THAT BELONG TO TENANT 2 (other ids: nothing)
--   crm_export.mk_orders_summary()
--        tenant-2 order count and newest updatedAt (the sync's probe)
-- Page size is clamped to 1..2000; the id list to 2000 ids.
--
-- Tenant: resolved by SLUG ('naturatherapy-mk') through public."Tenant" on
-- every call — never by number. A renamed slug makes every call RAISE.
--
-- Columns: the minimum the CRM's web block needs. No names, e-mail, address,
-- comment, payment refs, attribution JSON or customer ids. phone is included
-- on purpose: the CRM stores it as E.164 + last-8 for customer matching.
-- Timestamps: the shop stores UTC in timestamp(3) WITHOUT time zone (its own
-- panel reads them AT TIME ZONE 'UTC'), exported as timestamptz.
--
-- The role: LOGIN, no inheritance, no memberships, read-only by default, 30 s
-- statement timeout, 3 connections; USAGE on crm_export + EXECUTE on the four
-- functions — no table privilege anywhere.
--
-- Idempotent: safe to re-run. Functions are dropped and recreated (grants
-- re-applied in the same transaction), the role is created once and its
-- attributes re-asserted. The password is NOT set here.
--
-- ROLLBACK (run as postgres on the SHOP database; removes everything this
-- file created and nothing else — nothing in the shop depends on it):
--   BEGIN;
--   DROP SCHEMA IF EXISTS crm_export CASCADE;
--   SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'elyon_crm_reader';
--   DROP ROLE IF EXISTS elyon_crm_reader;
--   COMMIT;
-- ============================================================================

BEGIN;

-- Fail fast instead of queueing live checkout traffic behind a lock.
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ── 0. Preconditions: this must be the SHOP database, and tenant 2 must exist
DO $pre$
BEGIN
  IF to_regclass('public."Order"') IS NULL
     OR to_regclass('public."OrderItem"') IS NULL
     OR to_regclass('public."Tenant"') IS NULL THEN
    RAISE EXCEPTION 'crm_export: public."Order"/"OrderItem"/"Tenant" not found — this is not the shop database';
  END IF;
  -- The Elyon CRM has public.orders + public.mex_parcels. Never apply there.
  IF to_regclass('public.orders') IS NOT NULL OR to_regclass('public.mex_parcels') IS NOT NULL THEN
    RAISE EXCEPTION 'crm_export: public.orders / public.mex_parcels exist — this is the Elyon CRM, not the shop. Aborting.';
  END IF;
  IF (SELECT count(*) FROM public."Tenant" WHERE slug = 'naturatherapy-mk') <> 1 THEN
    RAISE EXCEPTION 'crm_export: tenant slug naturatherapy-mk not found (or not unique)';
  END IF;
END
$pre$;

-- ── 1. The schema ───────────────────────────────────────────────────────────
CREATE SCHEMA IF NOT EXISTS crm_export;
REVOKE ALL ON SCHEMA crm_export FROM PUBLIC;
COMMENT ON SCHEMA crm_export IS
  'Read-only export of naturatherapy.mk (tenant slug naturatherapy-mk) orders for the Elyon CRM. Owner-approved 2026-09-27. Late-bound PL/pgSQL functions only: no dependency on any shop column. Outside public so prisma db push never sees it. Reader: elyon_crm_reader (EXECUTE on the four functions only). Rollback: DROP SCHEMA crm_export CASCADE; DROP ROLE elyon_crm_reader.';

-- ── 2. The role (password is set by the apply script as a SCRAM verifier) ──
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'elyon_crm_reader') THEN
    CREATE ROLE elyon_crm_reader WITH LOGIN NOINHERIT;
  END IF;
END
$role$;

-- Only LOGIN/NOINHERIT/limit are named: Supabase's postgres is not a superuser,
-- and naming SUPERUSER/REPLICATION/BYPASSRLS at all (even NO…) is refused. A
-- new role is created without them; the self-test (5.1) proves it after apply.
ALTER ROLE elyon_crm_reader WITH LOGIN NOCREATEDB NOCREATEROLE NOINHERIT CONNECTION LIMIT 3;
ALTER ROLE elyon_crm_reader SET default_transaction_read_only = on;
ALTER ROLE elyon_crm_reader SET statement_timeout = '30s';
ALTER ROLE elyon_crm_reader SET idle_in_transaction_session_timeout = '60s';
COMMENT ON ROLE elyon_crm_reader IS
  'Elyon CRM web-sync reader (owner-approved 2026-09-27): USAGE on crm_export + EXECUTE on its four read-only functions. No table privilege anywhere. Read-only, 30 s timeout, 3 connections.';

-- ── 3. The export ───────────────────────────────────────────────────────────
-- An earlier draft used views; if that draft was ever applied, remove them so
-- no view pins a shop column.
DROP VIEW IF EXISTS crm_export.mk_order_items;
DROP VIEW IF EXISTS crm_export.mk_orders;
-- Dropped and recreated so a changed signature/result never trips CREATE OR
-- REPLACE; the grants are re-applied below in the same transaction.
DROP FUNCTION IF EXISTS crm_export.mk_orders(timestamptz, integer, integer);
DROP FUNCTION IF EXISTS crm_export.mk_orders_by_id(integer, integer);
DROP FUNCTION IF EXISTS crm_export.mk_order_items(integer[]);
DROP FUNCTION IF EXISTS crm_export.mk_orders_summary();

-- Incremental feed: tenant-2 orders strictly after (p_updated_after,
-- p_after_id) in (updatedAt, id) order. NULL p_updated_after = from the start.
CREATE FUNCTION crm_export.mk_orders(
  p_updated_after timestamptz,
  p_after_id      integer,
  p_limit         integer)
RETURNS TABLE (
  shop_order_id      integer,
  order_number       text,
  tenant_slug        text,
  status             text,
  payment_method     text,
  payment_status     text,
  total              numeric,
  shipping_total     numeric,
  discount_total     numeric,
  currency           text,
  city               text,
  phone              text,
  source             text,
  channel            text,
  traffic_source     text,
  campaign           text,
  discount_code      text,
  shipping_carrier   text,
  shipping_method    text,
  tracking_number    text,
  tracking_status    text,
  tracking_status_at timestamptz,
  shipped_at         timestamptz,
  created_at         timestamptz,
  updated_at         timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $fn$
#variable_conflict use_column
DECLARE
  _tid   integer;
  _after timestamp := coalesce(p_updated_after, '-infinity'::timestamptz) AT TIME ZONE 'UTC';
  _id    integer   := coalesce(p_after_id, 0);
  _lim   integer   := least(greatest(coalesce(p_limit, 500), 1), 2000);
BEGIN
  SELECT t.id INTO _tid FROM public."Tenant" t WHERE t.slug = 'naturatherapy-mk';
  IF _tid IS NULL THEN
    RAISE EXCEPTION 'crm_export: tenant naturatherapy-mk not found';
  END IF;
  RETURN QUERY
  SELECT o.id::integer, o."orderNumber"::text, t.slug::text,
         o.status::text, o."paymentMethod"::text, o."paymentStatus"::text,
         o.total::numeric, o."shippingTotal"::numeric, o."discountTotal"::numeric,
         o.currency::text, o.city::text, o.phone::text,
         o.source::text, o.channel::text, o."trafficSource"::text, o.campaign::text, o."discountCode"::text,
         o."shippingCarrier"::text, o."shippingMethod"::text,
         o."trackingNumber"::text, o."trackingStatus"::text,
         (o."trackingStatusAt" AT TIME ZONE 'UTC')::timestamptz,
         (o."shippedAt"        AT TIME ZONE 'UTC')::timestamptz,
         (o."createdAt"        AT TIME ZONE 'UTC')::timestamptz,
         (o."updatedAt"        AT TIME ZONE 'UTC')::timestamptz
  FROM public."Order" o
  JOIN public."Tenant" t ON t.id = o."tenantId"
  WHERE o."tenantId" = _tid
    AND t.slug = 'naturatherapy-mk'
    AND (o."updatedAt", o.id) > (_after, _id)
  ORDER BY o."updatedAt", o.id
  LIMIT _lim;
END
$fn$;

-- Full sweep: tenant-2 orders with id > p_after_id, in id order.
CREATE FUNCTION crm_export.mk_orders_by_id(
  p_after_id integer,
  p_limit    integer)
RETURNS TABLE (
  shop_order_id      integer,
  order_number       text,
  tenant_slug        text,
  status             text,
  payment_method     text,
  payment_status     text,
  total              numeric,
  shipping_total     numeric,
  discount_total     numeric,
  currency           text,
  city               text,
  phone              text,
  source             text,
  channel            text,
  traffic_source     text,
  campaign           text,
  discount_code      text,
  shipping_carrier   text,
  shipping_method    text,
  tracking_number    text,
  tracking_status    text,
  tracking_status_at timestamptz,
  shipped_at         timestamptz,
  created_at         timestamptz,
  updated_at         timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $fn$
#variable_conflict use_column
DECLARE
  _tid integer;
  _id  integer := coalesce(p_after_id, 0);
  _lim integer := least(greatest(coalesce(p_limit, 500), 1), 2000);
BEGIN
  SELECT t.id INTO _tid FROM public."Tenant" t WHERE t.slug = 'naturatherapy-mk';
  IF _tid IS NULL THEN
    RAISE EXCEPTION 'crm_export: tenant naturatherapy-mk not found';
  END IF;
  RETURN QUERY
  SELECT o.id::integer, o."orderNumber"::text, t.slug::text,
         o.status::text, o."paymentMethod"::text, o."paymentStatus"::text,
         o.total::numeric, o."shippingTotal"::numeric, o."discountTotal"::numeric,
         o.currency::text, o.city::text, o.phone::text,
         o.source::text, o.channel::text, o."trafficSource"::text, o.campaign::text, o."discountCode"::text,
         o."shippingCarrier"::text, o."shippingMethod"::text,
         o."trackingNumber"::text, o."trackingStatus"::text,
         (o."trackingStatusAt" AT TIME ZONE 'UTC')::timestamptz,
         (o."shippedAt"        AT TIME ZONE 'UTC')::timestamptz,
         (o."createdAt"        AT TIME ZONE 'UTC')::timestamptz,
         (o."updatedAt"        AT TIME ZONE 'UTC')::timestamptz
  FROM public."Order" o
  JOIN public."Tenant" t ON t.id = o."tenantId"
  WHERE o."tenantId" = _tid
    AND t.slug = 'naturatherapy-mk'
    AND o.id > _id
  ORDER BY o.id
  LIMIT _lim;
END
$fn$;

-- Lines of the given orders — only of those that are tenant-2 orders. An id
-- of another tenant's order returns nothing.
CREATE FUNCTION crm_export.mk_order_items(p_order_ids integer[])
RETURNS TABLE (
  shop_item_id       integer,
  shop_order_id      integer,
  tenant_slug        text,
  product_id         integer,
  variant_id         integer,
  name               text,
  variant_label      text,
  sku                text,
  quantity           integer,
  price              numeric,
  discount_allocated numeric,
  kind               text,
  compare_at_price   numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $fn$
#variable_conflict use_column
DECLARE
  _tid integer;
BEGIN
  IF p_order_ids IS NULL OR cardinality(p_order_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(p_order_ids) > 2000 THEN
    RAISE EXCEPTION 'crm_export.mk_order_items: at most 2000 order ids per call (got %)', cardinality(p_order_ids);
  END IF;
  SELECT t.id INTO _tid FROM public."Tenant" t WHERE t.slug = 'naturatherapy-mk';
  IF _tid IS NULL THEN
    RAISE EXCEPTION 'crm_export: tenant naturatherapy-mk not found';
  END IF;
  RETURN QUERY
  SELECT i.id::integer, i."orderId"::integer, t.slug::text,
         i."productId"::integer, i."variantId"::integer,
         i.name::text, i."variantLabel"::text, i.sku::text,
         i.quantity::integer, i.price::numeric, i."discountAllocated"::numeric,
         i.kind::text, i."compareAtPrice"::numeric
  FROM public."OrderItem" i
  JOIN public."Order"  o ON o.id = i."orderId"
  JOIN public."Tenant" t ON t.id = o."tenantId"
  WHERE o."tenantId" = _tid
    AND t.slug = 'naturatherapy-mk'
    AND i."orderId" = ANY (p_order_ids)
  ORDER BY i."orderId", i.id;
END
$fn$;

-- The sync's probe: how many tenant-2 orders exist, and the newest change.
CREATE FUNCTION crm_export.mk_orders_summary()
RETURNS TABLE (orders bigint, max_updated_at timestamptz)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
SET TimeZone = 'UTC'
AS $fn$
#variable_conflict use_column
DECLARE
  _tid integer;
BEGIN
  SELECT t.id INTO _tid FROM public."Tenant" t WHERE t.slug = 'naturatherapy-mk';
  IF _tid IS NULL THEN
    RAISE EXCEPTION 'crm_export: tenant naturatherapy-mk not found';
  END IF;
  RETURN QUERY
  SELECT count(*)::bigint, (max(o."updatedAt") AT TIME ZONE 'UTC')::timestamptz
  FROM public."Order" o
  WHERE o."tenantId" = _tid;
END
$fn$;

COMMENT ON FUNCTION crm_export.mk_orders(timestamptz, integer, integer) IS
  'naturatherapy.mk (tenant slug naturatherapy-mk) orders after (p_updated_after, p_after_id) in (updatedAt, id) order, max 2000. Read-only, late-bound (no dependency on shop columns). Timestamps UTC timestamptz; money in the order currency (MKD).';
COMMENT ON FUNCTION crm_export.mk_orders_by_id(integer, integer) IS
  'naturatherapy.mk orders with id > p_after_id in id order, max 2000 — the CRM''s full sweep. Read-only, late-bound.';
COMMENT ON FUNCTION crm_export.mk_order_items(integer[]) IS
  'Lines of the given naturatherapy.mk orders (ids of any other tenant return nothing), max 2000 ids. Read-only, late-bound. kind = SALE | GIFT.';
COMMENT ON FUNCTION crm_export.mk_orders_summary() IS
  'naturatherapy.mk order count and newest updatedAt (UTC). Read-only, late-bound.';

-- ── 4. Grants: EXECUTE for the reader, nobody else ──────────────────────────
-- New functions are executable by PUBLIC by default; take that away, and
-- revoke from any other grantee a default privilege may have added.
DO $revoke$
DECLARE
  _f   text;
  _who text;
BEGIN
  FOREACH _f IN ARRAY ARRAY[
      'crm_export.mk_orders(timestamptz, integer, integer)',
      'crm_export.mk_orders_by_id(integer, integer)',
      'crm_export.mk_order_items(integer[])',
      'crm_export.mk_orders_summary()'] LOOP
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
  END LOOP;
END
$revoke$;

GRANT USAGE ON SCHEMA crm_export TO elyon_crm_reader;
GRANT EXECUTE ON FUNCTION
  crm_export.mk_orders(timestamptz, integer, integer),
  crm_export.mk_orders_by_id(integer, integer),
  crm_export.mk_order_items(integer[]),
  crm_export.mk_orders_summary()
  TO elyon_crm_reader;

-- ── 5. Self-test (negative). Any failure raises → the whole file rolls back.
DO $selftest$
DECLARE
  _mk       integer;
  _funcs    oid[] := ARRAY[
      'crm_export.mk_orders(timestamptz, integer, integer)'::regprocedure::oid,
      'crm_export.mk_orders_by_id(integer, integer)'::regprocedure::oid,
      'crm_export.mk_order_items(integer[])'::regprocedure::oid,
      'crm_export.mk_orders_summary()'::regprocedure::oid];
  _bad      text;
  _n        bigint;
  _m        bigint;
  _after    integer := 0;
  _page     integer;
  _foreign  bigint := 0;
  _other    integer[];
  _r        record;
  _can_set  boolean := false;
  _leak     boolean;
BEGIN
  SELECT id INTO _mk FROM public."Tenant" WHERE slug = 'naturatherapy-mk';

  -- 5.1 The reader is a plain login: no superpowers, no memberships.
  SELECT * INTO _r FROM pg_roles WHERE rolname = 'elyon_crm_reader';
  IF _r.rolsuper OR _r.rolcreaterole OR _r.rolcreatedb OR _r.rolreplication
     OR _r.rolbypassrls OR _r.rolinherit OR NOT _r.rolcanlogin THEN
    RAISE EXCEPTION 'selftest: elyon_crm_reader has unexpected attributes';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members WHERE member = 'elyon_crm_reader'::regrole) THEN
    RAISE EXCEPTION 'selftest: elyon_crm_reader is a member of another role (would inherit its privileges)';
  END IF;

  -- 5.2 No table privilege anywhere. (a) No relation or column ACL in the
  -- whole database names the reader. (b) Nothing in the shop's data schemas
  -- is readable by it through PUBLIC either. (c) crm_export has no relations.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY 1) INTO _bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'elyon_crm_reader'::regrole)
     OR EXISTS (SELECT 1 FROM pg_attribute att, aclexplode(att.attacl) a
                 WHERE att.attrelid = c.oid AND a.grantee = 'elyon_crm_reader'::regrole);
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: a table/column grant names elyon_crm_reader: %', _bad;
  END IF;
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY 1) INTO _bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname IN ('public', 'auth', 'storage', 'vault', 'crm_export')
    AND (has_table_privilege('elyon_crm_reader', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
         OR has_any_column_privilege('elyon_crm_reader', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES'));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: elyon_crm_reader can reach tables: %', _bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'crm_export'::regnamespace) THEN
    RAISE EXCEPTION 'selftest: crm_export must hold functions only (no tables or views)';
  END IF;
  -- Anything a platform PUBLIC grant exposes in another schema is listed for
  -- the operator, not silently accepted.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY 1) INTO _bad
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE c.relkind IN ('r', 'p', 'v', 'm', 'f')
    AND n.nspname NOT IN ('crm_export', 'public', 'auth', 'storage', 'vault', 'pg_catalog', 'information_schema')
    AND n.nspname NOT LIKE 'pg\_%'
    AND has_schema_privilege('elyon_crm_reader', n.oid, 'USAGE')
    AND has_table_privilege('elyon_crm_reader', c.oid, 'SELECT');
  IF _bad IS NOT NULL THEN
    RAISE NOTICE 'selftest: note — platform PUBLIC grants (not ours) let any login read: %', _bad;
  END IF;

  -- 5.3 crm_export: USAGE, no CREATE; EXECUTE on exactly the four functions;
  -- nobody else (PUBLIC included) may execute them; no other function grant
  -- anywhere names the reader.
  IF NOT has_schema_privilege('elyon_crm_reader', 'crm_export', 'USAGE')
     OR has_schema_privilege('elyon_crm_reader', 'crm_export', 'CREATE') THEN
    RAISE EXCEPTION 'selftest: crm_export schema privileges are wrong for the reader';
  END IF;
  IF (SELECT count(*) FROM pg_proc p WHERE p.pronamespace = 'crm_export'::regnamespace) <> 4
     OR EXISTS (SELECT 1 FROM unnest(_funcs) f(oid)
                WHERE NOT has_function_privilege('elyon_crm_reader', f.oid, 'EXECUTE')) THEN
    RAISE EXCEPTION 'selftest: the reader must execute exactly the four export functions';
  END IF;
  SELECT string_agg(DISTINCT coalesce(r.rolname, 'PUBLIC'), ', ') INTO _bad
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  LEFT JOIN pg_roles r ON r.oid = a.grantee
  WHERE p.oid = ANY (_funcs)
    AND a.grantee <> p.proowner
    AND a.grantee <> 'elyon_crm_reader'::regrole;
  IF _bad IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ANY (_funcs) AND p.proacl IS NULL) THEN
    RAISE EXCEPTION 'selftest: others can execute the export functions: %', coalesce(_bad, 'PUBLIC (default ACL)');
  END IF;
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO _bad
  FROM pg_proc p
  CROSS JOIN LATERAL aclexplode(p.proacl) a
  WHERE a.grantee = 'elyon_crm_reader'::regrole
    AND NOT (p.oid = ANY (_funcs));
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'selftest: other function grants name the reader: %', _bad;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = ANY (_funcs)
             AND (NOT p.prosecdef OR p.provolatile <> 's' OR p.proowner <> current_user::regrole
                  OR NOT coalesce('search_path=pg_catalog, pg_temp' = ANY (p.proconfig), false)
                  OR NOT coalesce('TimeZone=UTC' = ANY (p.proconfig), false))) THEN
    RAISE EXCEPTION 'selftest: an export function is not STABLE SECURITY DEFINER owned by % with search_path pg_catalog, pg_temp and TimeZone UTC', current_user;
  END IF;

  -- 5.4 THE point of functions: nothing in the shop depends on the export.
  -- Zero pg_depend rows from these functions to any table or column.
  IF EXISTS (SELECT 1 FROM pg_depend d
             WHERE d.classid = 'pg_proc'::regclass
               AND d.objid = ANY (_funcs)
               AND d.refclassid = 'pg_class'::regclass) THEN
    RAISE EXCEPTION 'selftest: an export function records a dependency on a table/column';
  END IF;

  -- 5.5 Tenant isolation, exhaustively: sweep every page of the by-id feed.
  _n := 0;
  LOOP
    _page := 0;
    FOR _r IN SELECT * FROM crm_export.mk_orders_by_id(_after, 2000) LOOP
      _page := _page + 1;
      _n := _n + 1;
      _after := _r.shop_order_id;
      IF _r.tenant_slug IS DISTINCT FROM 'naturatherapy-mk' THEN _foreign := _foreign + 1; END IF;
    END LOOP;
    EXIT WHEN _page < 2000;
  END LOOP;
  SELECT count(*) INTO _m FROM public."Order" WHERE "tenantId" = _mk;
  IF _foreign <> 0 OR _n <> _m THEN
    RAISE EXCEPTION 'selftest: the sweep returned % orders (% foreign), tenant 2 has %', _n, _foreign, _m;
  END IF;
  SELECT count(*) INTO _n FROM crm_export.mk_orders(NULL, 0, 2000) WHERE tenant_slug IS DISTINCT FROM 'naturatherapy-mk';
  IF _n <> 0 THEN
    RAISE EXCEPTION 'selftest: the incremental feed returned % foreign rows', _n;
  END IF;
  SELECT orders INTO _n FROM crm_export.mk_orders_summary();
  IF _n <> _m THEN
    RAISE EXCEPTION 'selftest: summary says % orders, tenant 2 has %', _n, _m;
  END IF;
  -- Lines: ids of OTHER tenants' orders must return nothing.
  SELECT array_agg(id) INTO _other FROM (SELECT id FROM public."Order" WHERE "tenantId" <> _mk ORDER BY id DESC LIMIT 2000) x;
  IF _other IS NOT NULL
     AND EXISTS (SELECT 1 FROM crm_export.mk_order_items(_other)) THEN
    RAISE EXCEPTION 'selftest: mk_order_items returned lines of another tenant';
  END IF;
  RAISE NOTICE 'selftest: tenant 2 exports % orders; % orders of other tenants are excluded',
    _m, (SELECT count(*) FROM public."Order" WHERE "tenantId" <> _mk);

  -- 5.6 Behavioural probe AS the reader — only where this session may SET
  -- ROLE to it without granting anything new (PG16+: the creator's implicit
  -- membership may lack SET, in which case this is skipped; the apply script
  -- then proves the same thing by logging in as the reader over the pooler).
  BEGIN
    IF current_setting('server_version_num')::int >= 160000 THEN
      _can_set := pg_has_role('elyon_crm_reader', 'SET');
    ELSE
      _can_set := pg_has_role('elyon_crm_reader', 'MEMBER');
    END IF;
  EXCEPTION WHEN OTHERS THEN
    _can_set := false;
  END;

  IF _can_set THEN
    -- A direct SELECT on public."Order" must be refused.
    BEGIN
      SET LOCAL ROLE elyon_crm_reader;
      PERFORM 1 FROM public."Order" LIMIT 1;
      _leak := true;
    EXCEPTION WHEN insufficient_privilege THEN
      _leak := false;
    END;
    RESET ROLE;
    IF _leak THEN
      RAISE EXCEPTION 'selftest: AS elyon_crm_reader, SELECT on public."Order" succeeded';
    END IF;

    -- public."Tenant" too.
    BEGIN
      SET LOCAL ROLE elyon_crm_reader;
      PERFORM 1 FROM public."Tenant" LIMIT 1;
      _leak := true;
    EXCEPTION WHEN insufficient_privilege THEN
      _leak := false;
    END;
    RESET ROLE;
    IF _leak THEN
      RAISE EXCEPTION 'selftest: AS elyon_crm_reader, SELECT on public."Tenant" succeeded';
    END IF;

    -- The functions work for the reader, and never return another tenant.
    SET LOCAL ROLE elyon_crm_reader;
    SELECT count(*) FILTER (WHERE tenant_slug IS DISTINCT FROM 'naturatherapy-mk'), count(*)
      INTO _n, _m FROM crm_export.mk_orders(NULL, 0, 2000);
    RESET ROLE;
    IF _n <> 0 THEN
      RAISE EXCEPTION 'selftest: AS elyon_crm_reader, mk_orders returned % foreign rows', _n;
    END IF;
    RAISE NOTICE 'selftest: behavioural probe as elyon_crm_reader passed (% rows on the first page)', _m;
  ELSE
    RAISE NOTICE 'selftest: behavioural probe skipped (no SET ROLE membership); the apply script logs in as the reader instead';
  END IF;
END
$selftest$;

COMMIT;
