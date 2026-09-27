-- ============================================================================
-- WEB ORDERS — a read-only mirror of naturatherapy.mk (shop tenant 2)
-- (2026-09-28, the "Web shop" block of the connected Overview contract)
--
-- naturatherapy.mk is tenant 2 of the multi-tenant shop platform
-- (D:\naturatherapy\storefront, Supabase kctgthpoeysmhmkrnkil). Its orders
-- never enter public.orders: the shop auto-ships them through our NATURA MEX
-- account with no phone confirmation, so they are a separate sales source with
-- their OWN outcome rules. This migration keeps a faithful copy of them:
--
--   public.web_orders         one row per tenant-2 order (legacy OpenCart
--                             OC-… history since 2022-05-21 + native NTMK…
--                             since 2026-09-04), keyed by the shop's Order.id
--   public.web_order_items    their lines (SALE | GIFT)
--   public.web_sync_runs      one row per web-sync invocation (freshness,
--                             cursor, counts, errors)
--   web_order_outcome()       SQL twin of the shop's classifyOutcome()
--   web_order_money()         SQL twin of the shop's classifyMoney()
--   web_upsert_orders()       the only writer (service role, via web-sync)
--   web_link_mex_parcels()    links each web order to its MEX parcel,
--                             READ-ONLY on mex_parcels (never sets its
--                             order_id — that FK belongs to public.orders)
--   web_mark_deleted()        after a complete backfill: orders the shop no
--                             longer has (e.g. test orders it deleted)
--   insights_web_block()      the Overview's web block, jsonb
--
-- Writer: the web-sync edge function, reading the shop's crm_export functions
-- (late-bound PL/pgSQL, no dependency on shop columns) as elyon_crm_reader
-- (supabase/shop-side/crm_export_tenant2.sql). NOTHING is ever written to the
-- shop.
--
-- ── The shop's rules, ported verbatim (src/lib/order-outcome.ts) ────────────
-- Ordered, first match wins:
--   card_unpaid  CARD + (PENDING|CANCELLED) + payment not PAID/PARTIALLY_REFUNDED/
--                REFUNDED — a failed checkout, never counted anywhere
--   cancelled    CANCELLED
--   returned     RETURNED | REFUNDED
--   delivered    DELIVERED, or DONE with payment PAID|PARTIALLY_REFUNDED
--   no_record    DONE without payment (OpenCart history nobody recorded)
--   courier      SHIPPED
--   preparing    CONFIRMED | PROCESSING
--   awaiting     everything else (PENDING)
-- Money (status-based, card_unpaid rows dropped before summing):
--   lost         CANCELLED | RETURNED | REFUNDED, or payment REFUNDED
--   collected    payment PAID | PARTIALLY_REFUNDED
--   unrecorded   DONE (no payment record)
--   to_collect   everything else
-- Day = the order's CREATED instant in Europe/Skopje (the shop panel's day).
--
-- ⚠ One deliberate gap: the shop panel subtracts public."Refund" amounts from
-- `collected` for PARTIALLY_REFUNDED orders. The owner-approved export covers
-- Order/OrderItem only, so refunds are not mirrored; `collected_mkd` is GROSS
-- and the block reports `partially_refunded_count` so any divergence from the
-- panel is visible (MK is cash-on-delivery; the count is expected to be 0).
--
-- Security: web orders carry phones and money → SELECT for business owners
-- only (public.is_business_owner, 20260934000000). web_sync_runs holds no PII
-- or money → owners + admin/manager (same audience as mex_sync_runs). Every
-- writer is service_role; the functions are service_role-only.
-- ============================================================================

SET LOCAL lock_timeout = '5s';

-- ── 1. The shop's rules as SQL (IMMUTABLE; no table access) ─────────────────
CREATE OR REPLACE FUNCTION public.web_order_outcome(
  p_status text, p_payment_status text, p_payment_method text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_payment_method = 'CARD'
     AND p_status IN ('PENDING', 'CANCELLED')
     AND p_payment_status NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')   THEN 'card_unpaid'
    WHEN p_status = 'CANCELLED'                                                THEN 'cancelled'
    WHEN p_status IN ('RETURNED', 'REFUNDED')                                  THEN 'returned'
    WHEN p_status = 'DELIVERED'                                                THEN 'delivered'
    WHEN p_status = 'DONE' AND p_payment_status IN ('PAID', 'PARTIALLY_REFUNDED') THEN 'delivered'
    WHEN p_status = 'DONE'                                                     THEN 'no_record'
    WHEN p_status = 'SHIPPED'                                                  THEN 'courier'
    WHEN p_status IN ('CONFIRMED', 'PROCESSING')                               THEN 'preparing'
    ELSE 'awaiting'
  END
$$;

COMMENT ON FUNCTION public.web_order_outcome(text, text, text) IS
  'SQL twin of the shop''s classifyOutcome() (storefront src/lib/order-outcome.ts): card_unpaid | cancelled | returned | delivered | no_record | courier | preparing | awaiting. Change it only together with the shop''s rules.';

CREATE OR REPLACE FUNCTION public.web_order_money(p_status text, p_payment_status text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE
    WHEN p_status IN ('CANCELLED', 'RETURNED', 'REFUNDED')
      OR p_payment_status = 'REFUNDED'                       THEN 'lost'
    WHEN p_payment_status IN ('PAID', 'PARTIALLY_REFUNDED')  THEN 'collected'
    WHEN p_status = 'DONE'                                   THEN 'unrecorded'
    ELSE 'to_collect'
  END
$$;

COMMENT ON FUNCTION public.web_order_money(text, text) IS
  'SQL twin of the shop''s classifyMoney(): lost | collected | unrecorded | to_collect.';

-- Tenant-2 order numbers: legacy OpenCart `OC-<id>` and native `NTMK<1000+id>`.
-- (OC- alone is NOT a tenant marker — the Greek tenant imports OC-… too; the
-- tenant is proven by the export's slug, this is the second fence.)
CREATE OR REPLACE FUNCTION public.web_order_number_ok(p_number text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT coalesce(p_number ~ '^(OC-[0-9]{1,12}|NTMK[0-9]{1,12})$', false)
$$;

-- Phone → E.164 (+389). Mirrors mkE164 (mex-reconcile/match.ts) and also
-- understands the 00389 prefix. A foreign number (+381…, +40…) is NOT
-- rewritten into +389 — it becomes NULL (phone8 still carries its last 8).
CREATE OR REPLACE FUNCTION public.web_phone_e164(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN length(n) BETWEEN 8 AND 9 THEN '+389' || n END
  FROM (SELECT ltrim(CASE WHEN d LIKE '389%' THEN substr(d, 4) ELSE d END, '0') AS n
        FROM (SELECT CASE WHEN dd LIKE '00%' THEN substr(dd, 3) ELSE dd END AS d
              FROM (SELECT regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') AS dd) a) b) c
$$;

-- Last 8 digits — the CRM's phone-matching canon (same as mex_parcels.phone8).
CREATE OR REPLACE FUNCTION public.web_phone8(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT CASE WHEN length(d) >= 8 THEN right(d, 8) END
  FROM (SELECT regexp_replace(coalesce(p_raw, ''), '[^0-9]', '', 'g') AS d) a
$$;

REVOKE ALL ON FUNCTION public.web_order_outcome(text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.web_order_money(text, text)         FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.web_order_number_ok(text)           FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.web_phone_e164(text)                FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.web_phone8(text)                    FROM PUBLIC, anon;
-- Pure classifiers: harmless to a signed-in owner writing a drill-down query.
GRANT EXECUTE ON FUNCTION public.web_order_outcome(text, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.web_order_money(text, text)         TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.web_order_number_ok(text)           TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.web_phone_e164(text)                TO service_role;
GRANT EXECUTE ON FUNCTION public.web_phone8(text)                    TO service_role;

-- ── 2. The mirror ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.web_orders (
  shop_order_id      integer PRIMARY KEY,           -- shop public."Order".id
  order_number       text NOT NULL
                     CONSTRAINT web_orders_number_check CHECK (public.web_order_number_ok(order_number)),
  is_legacy          boolean GENERATED ALWAYS AS (order_number LIKE 'OC-%') STORED,
  -- Enum values copied from the shop's Prisma schema. A value outside these
  -- lists fails the upsert LOUDLY on purpose: a new shop status means the
  -- classifier twin above must be reviewed before any number is trusted.
  status             text NOT NULL
                     CONSTRAINT web_orders_status_check CHECK (status IN (
                       'PENDING', 'CONFIRMED', 'PROCESSING', 'SHIPPED', 'DELIVERED',
                       'RETURNED', 'DONE', 'CANCELLED', 'REFUNDED')),
  payment_method     text NOT NULL
                     CONSTRAINT web_orders_payment_method_check CHECK (payment_method IN ('COD', 'CARD')),
  payment_status     text NOT NULL
                     CONSTRAINT web_orders_payment_status_check CHECK (payment_status IN (
                       'UNPAID', 'PENDING', 'PAID', 'FAILED', 'REFUNDED', 'PARTIALLY_REFUNDED')),
  total              numeric(12,2) NOT NULL,        -- in `currency` (MKD on this store)
  shipping_total     numeric(12,2),                 -- NULL on legacy rows
  discount_total     numeric(12,2),
  currency           text NOT NULL,
  city               text,
  phone              text,                          -- E.164 +389…, NULL if not an MK number
  phone8             text,                          -- last 8 digits (matching canon)
  source             text,                          -- shop CRM label: storefront | loyalty | opencart
  channel            text,                          -- marketing channel (TrafficChannel key)
  traffic_source     text,
  campaign           text,
  discount_code      text,
  shipping_carrier   text,
  shipping_method    text,
  tracking_number    text,                          -- the courier waybill the shop recorded
  tracking_status    text,                          -- the courier's own latest wording
  tracking_status_at timestamptz,
  shipped_at         timestamptz,
  created_at         timestamptz NOT NULL,          -- shop createdAt (UTC instant)
  updated_at         timestamptz NOT NULL,          -- shop updatedAt — the sync cursor
  -- Link to the courier's record. READ-ONLY toward mex_parcels: decided here,
  -- never written into mex_parcels.order_id (that FK is public.orders').
  mex_tracking_id    text,
  mex_link_method    text
                     CONSTRAINT web_orders_mex_link_method_check
                     CHECK (mex_link_method IN ('tracking', 'sender_reference', 'order_number')),
  mex_linked_at      timestamptz,
  deleted_in_shop_at timestamptz,                   -- a complete backfill no longer saw it
  first_synced_at    timestamptz NOT NULL DEFAULT now(),
  last_synced_at     timestamptz NOT NULL DEFAULT now(),  -- last time its DATA changed
  last_seen_at       timestamptz NOT NULL DEFAULT now()   -- last time a sync read it
);

COMMENT ON TABLE public.web_orders IS
  'Read-only mirror of naturatherapy.mk (shop tenant 2) orders, legacy OC-… + native NTMK…. Written only by web_upsert_orders (web-sync edge function, service role). Classify with web_order_outcome()/web_order_money(). SELECT: business owners only.';
COMMENT ON COLUMN public.web_orders.total IS
  'Order total in `currency` exactly as the shop stores it (MKD on this store). NOT converted — web money is reported in denari.';
COMMENT ON COLUMN public.web_orders.mex_tracking_id IS
  'MEX parcel this order shipped under (web_link_mex_parcels): tracking = the shop''s waybill; sender_reference / order_number = the shop''s own reference as MEX stored it. Read from mex_parcels, never written into it.';
COMMENT ON COLUMN public.web_orders.deleted_in_shop_at IS
  'Set when a COMPLETE backfill no longer found the order in the shop (e.g. a deleted test order); cleared if it reappears. Excluded from every web number.';

-- Order numbers are unique per store at any moment; a number can only move to
-- a new id after the old order was deleted, so uniqueness holds among live rows.
CREATE UNIQUE INDEX IF NOT EXISTS uq_web_orders_number_live
  ON public.web_orders (order_number) WHERE deleted_in_shop_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_web_orders_created    ON public.web_orders (created_at);
CREATE INDEX IF NOT EXISTS idx_web_orders_updated    ON public.web_orders (updated_at);
CREATE INDEX IF NOT EXISTS idx_web_orders_phone8     ON public.web_orders (phone8);
CREATE INDEX IF NOT EXISTS idx_web_orders_tracking   ON public.web_orders (tracking_number) WHERE tracking_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_web_orders_mex        ON public.web_orders (mex_tracking_id) WHERE mex_tracking_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.web_order_items (
  shop_item_id       integer PRIMARY KEY,           -- shop public."OrderItem".id
  shop_order_id      integer NOT NULL REFERENCES public.web_orders(shop_order_id) ON DELETE CASCADE,
  product_id         integer,                       -- SHOP product id (not a CRM product)
  variant_id         integer,
  name               text NOT NULL,
  variant_label      text,
  sku                text,
  quantity           integer NOT NULL,
  price              numeric(12,2) NOT NULL,        -- unit price, order currency
  discount_allocated numeric(12,2),
  kind               text NOT NULL DEFAULT 'SALE',  -- SALE | GIFT (gift lines are price 0)
  compare_at_price   numeric(12,2),
  last_synced_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.web_order_items IS
  'Lines of public.web_orders (naturatherapy.mk tenant 2). product_id is the SHOP''s product id. Written only by web_upsert_orders. SELECT: business owners only.';

CREATE INDEX IF NOT EXISTS idx_web_order_items_order ON public.web_order_items (shop_order_id);

CREATE TABLE IF NOT EXISTS public.web_sync_runs (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                        text NOT NULL
                              CONSTRAINT web_sync_runs_kind_check CHECK (kind IN ('incremental', 'backfill')),
  status                      text NOT NULL DEFAULT 'running'
                              CONSTRAINT web_sync_runs_status_check
                              CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  -- incremental: keyset cursor over the shop's (updatedAt, id)
  cursor_from_updated_at      timestamptz,
  cursor_from_id              integer,
  cursor_to_updated_at        timestamptz,
  cursor_to_id                integer,
  -- backfill: keyset over the shop's id; a session may span several calls
  backfill_session            uuid,
  backfill_session_started_at timestamptz,
  backfill_after_id           integer,
  backfill_done               boolean NOT NULL DEFAULT false,
  read_orders                 integer NOT NULL DEFAULT 0,
  read_items                  integer NOT NULL DEFAULT 0,
  new_orders                  integer NOT NULL DEFAULT 0,
  changed_orders              integer NOT NULL DEFAULT 0,
  rejected                    integer NOT NULL DEFAULT 0,
  marked_deleted              integer NOT NULL DEFAULT 0,
  mex_linked                  integer NOT NULL DEFAULT 0,
  shop_total_orders           integer,             -- tenant-2 order count in the shop at run time
  shop_max_updated_at         timestamptz,
  stats                       jsonb NOT NULL DEFAULT '{}'::jsonb,
  error                       text,                -- why the run FAILED
  warning                     text,                -- an ok run that still needs a look (rejected rows)
  started_at                  timestamptz NOT NULL DEFAULT now(),
  finished_at                 timestamptz,
  duration_ms                 integer
);

COMMENT ON TABLE public.web_sync_runs IS
  'One row per web-sync invocation (naturatherapy.mk mirror): freshness for the Overview, the incremental cursor (last ok/partial run), backfill sessions, counts and errors. Written by the web-sync edge function (service role).';
COMMENT ON COLUMN public.web_sync_runs.rejected IS
  'Shop rows NOT mirrored because their number is neither OC-… nor NTMK… (sample in stats.rejected_sample). Never blocks the cursor; the nightly sweep re-reports them until web_order_number_ok() and web-sync''s ORDER_NUMBER_RE are widened — then the next sweep mirrors them.';

CREATE INDEX IF NOT EXISTS idx_web_sync_runs_started ON public.web_sync_runs (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_web_sync_runs_kind_status ON public.web_sync_runs (kind, status, started_at DESC);

-- ── 3. RLS: owners read the mirror; admin/manager may read run health ──────
ALTER TABLE public.web_orders      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.web_sync_runs   ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS web_orders_select_owners ON public.web_orders;
CREATE POLICY web_orders_select_owners ON public.web_orders
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS web_order_items_select_owners ON public.web_order_items;
CREATE POLICY web_order_items_select_owners ON public.web_order_items
  FOR SELECT TO authenticated
  USING ((SELECT public.is_business_owner(auth.uid())));

DROP POLICY IF EXISTS web_sync_runs_select ON public.web_sync_runs;
CREATE POLICY web_sync_runs_select ON public.web_sync_runs
  FOR SELECT TO authenticated
  USING (
    (SELECT public.is_business_owner(auth.uid()))
    OR (SELECT public.has_role(auth.uid(), 'admin'::app_role))
    OR (SELECT public.has_role(auth.uid(), 'manager'::app_role))
  );

-- Default privileges hand new public tables to anon/authenticated in full;
-- take that back so SELECT (through the policies) is all that remains.
REVOKE ALL ON public.web_orders, public.web_order_items, public.web_sync_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.web_orders, public.web_order_items, public.web_sync_runs TO authenticated;
GRANT ALL    ON public.web_orders, public.web_order_items, public.web_sync_runs TO service_role;

-- ── 4. The writer ───────────────────────────────────────────────────────────
-- p_orders: JSON array of crm_export.mk_orders rows; p_items: JSON array of
-- crm_export.mk_order_items rows. p_items_complete = true promises p_items
-- holds EVERY line of every order in p_orders (then lines the shop removed
-- are deleted here); false only upserts lines.
--
-- Guards (a violation raises — the whole batch is refused, nothing written):
--   * tenant_slug must be 'naturatherapy-mk' on every order AND item
--   * order_number must be OC-… or NTMK…
--   * every item must belong to an order of this batch
-- Monotonic: a row is only overwritten by an equal-or-newer shop updated_at,
-- so two overlapping runs can never roll an order back to an older state.
-- An order_number now held by a different shop id retires the old row
-- (deleted_in_shop_at) — the shop guarantees one live holder per number.
CREATE OR REPLACE FUNCTION public.web_upsert_orders(
  p_orders jsonb,
  p_items jsonb DEFAULT '[]'::jsonb,
  p_items_complete boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _received       integer;
  _items_received integer;
  _bad            text;
  _new            integer := 0;
  _changed        integer := 0;
  _stale          integer := 0;
  _written        integer := 0;
  _retired        integer := 0;
  _items_upserted integer := 0;
  _items_deleted  integer := 0;
BEGIN
  IF p_orders IS NULL OR jsonb_typeof(p_orders) <> 'array' THEN
    RAISE EXCEPTION 'web_upsert_orders: p_orders must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  p_items := coalesce(p_items, '[]'::jsonb);
  IF jsonb_typeof(p_items) <> 'array' THEN
    RAISE EXCEPTION 'web_upsert_orders: p_items must be a JSON array' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  _received := jsonb_array_length(p_orders);
  _items_received := jsonb_array_length(p_items);
  IF _received > 2000 OR _items_received > 20000 THEN
    RAISE EXCEPTION 'web_upsert_orders: batch too large (% orders, % items)', _received, _items_received
      USING ERRCODE = 'program_limit_exceeded';
  END IF;
  IF _received = 0 THEN
    RETURN jsonb_build_object('received', 0, 'written', 0, 'new', 0, 'changed', 0, 'stale', 0,
                              'retired', 0, 'items_received', _items_received,
                              'items_upserted', 0, 'items_deleted', 0);
  END IF;

  -- ── guards ──
  SELECT string_agg(x.label, ', ') INTO _bad
  FROM (
    SELECT coalesce(e->>'order_number', '?') || ' (' || r.reason || ')' AS label
    FROM jsonb_array_elements(p_orders) e
    CROSS JOIN LATERAL (SELECT CASE
        WHEN jsonb_typeof(e) <> 'object'                               THEN 'not an object'
        WHEN (e->>'tenant_slug') IS DISTINCT FROM 'naturatherapy-mk'   THEN 'foreign tenant ' || coalesce(e->>'tenant_slug', 'NULL')
        WHEN NOT public.web_order_number_ok(e->>'order_number')        THEN 'order number'
        WHEN coalesce(e->>'shop_order_id', '') !~ '^[0-9]{1,9}$'       THEN 'shop_order_id'
        WHEN (e->>'created_at') IS NULL OR (e->>'updated_at') IS NULL  THEN 'timestamps'
        WHEN (e->>'total') IS NULL                                     THEN 'total'
      END AS reason) r
    WHERE r.reason IS NOT NULL
    LIMIT 10
  ) x;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'web_upsert_orders: refused batch — %', _bad USING ERRCODE = 'check_violation';
  END IF;

  SELECT string_agg(x.label, ', ') INTO _bad
  FROM (
    SELECT coalesce(e->>'shop_item_id', '?') || ' (' || r.reason || ')' AS label
    FROM jsonb_array_elements(p_items) e
    CROSS JOIN LATERAL (SELECT CASE
        WHEN jsonb_typeof(e) <> 'object'                               THEN 'not an object'
        WHEN (e->>'tenant_slug') IS DISTINCT FROM 'naturatherapy-mk'   THEN 'foreign tenant ' || coalesce(e->>'tenant_slug', 'NULL')
        WHEN coalesce(e->>'shop_item_id', '') !~ '^[0-9]{1,9}$'        THEN 'shop_item_id'
        WHEN coalesce(e->>'shop_order_id', '') !~ '^[0-9]{1,9}$'       THEN 'shop_order_id'
        WHEN NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_orders) o
                          WHERE o->>'shop_order_id' = e->>'shop_order_id') THEN 'order not in batch'
      END AS reason) r
    WHERE r.reason IS NOT NULL
    LIMIT 10
  ) x;
  IF _bad IS NOT NULL THEN
    RAISE EXCEPTION 'web_upsert_orders: refused items — %', _bad USING ERRCODE = 'check_violation';
  END IF;

  -- ── parse (one row per shop id; the freshest repeat wins) ──
  DROP TABLE IF EXISTS pg_temp.web_src;
  CREATE TEMP TABLE web_src ON COMMIT DROP AS
  SELECT DISTINCT ON (x.shop_order_id) x.*
  FROM (
    SELECT
      (e->>'shop_order_id')::integer                          AS shop_order_id,
      btrim(e->>'order_number')                               AS order_number,
      e->>'status'                                            AS status,
      e->>'payment_method'                                    AS payment_method,
      e->>'payment_status'                                    AS payment_status,
      (e->>'total')::numeric(12,2)                            AS total,
      nullif(e->>'shipping_total', '')::numeric(12,2)         AS shipping_total,
      nullif(e->>'discount_total', '')::numeric(12,2)         AS discount_total,
      coalesce(nullif(btrim(e->>'currency'), ''), 'MKD')      AS currency,
      nullif(btrim(e->>'city'), '')                           AS city,
      public.web_phone_e164(e->>'phone')                      AS phone,
      public.web_phone8(e->>'phone')                          AS phone8,
      nullif(e->>'source', '')                                AS source,
      nullif(e->>'channel', '')                               AS channel,
      nullif(e->>'traffic_source', '')                        AS traffic_source,
      nullif(e->>'campaign', '')                              AS campaign,
      nullif(e->>'discount_code', '')                         AS discount_code,
      nullif(e->>'shipping_carrier', '')                      AS shipping_carrier,
      nullif(e->>'shipping_method', '')                       AS shipping_method,
      nullif(btrim(e->>'tracking_number'), '')                AS tracking_number,
      nullif(e->>'tracking_status', '')                       AS tracking_status,
      nullif(e->>'tracking_status_at', '')::timestamptz       AS tracking_status_at,
      nullif(e->>'shipped_at', '')::timestamptz               AS shipped_at,
      (e->>'created_at')::timestamptz                         AS created_at,
      (e->>'updated_at')::timestamptz                         AS updated_at
    FROM jsonb_array_elements(p_orders) e
  ) x
  ORDER BY x.shop_order_id, x.updated_at DESC;

  -- ── what is about to happen (counts only) ──
  SELECT count(*) FILTER (WHERE w.shop_order_id IS NULL),
         count(*) FILTER (WHERE w.shop_order_id IS NOT NULL AND w.updated_at > s.updated_at),
         count(*) FILTER (WHERE w.shop_order_id IS NOT NULL AND w.updated_at <= s.updated_at
                            AND (w.order_number, w.status, w.payment_method, w.payment_status, w.total,
                                 w.shipping_total, w.discount_total, w.currency, w.city, w.phone, w.phone8,
                                 w.source, w.channel, w.traffic_source, w.campaign, w.discount_code,
                                 w.shipping_carrier, w.shipping_method, w.tracking_number, w.tracking_status,
                                 w.tracking_status_at, w.shipped_at, w.created_at, w.updated_at,
                                 w.deleted_in_shop_at IS NOT NULL)
                                IS DISTINCT FROM
                                (s.order_number, s.status, s.payment_method, s.payment_status, s.total,
                                 s.shipping_total, s.discount_total, s.currency, s.city, s.phone, s.phone8,
                                 s.source, s.channel, s.traffic_source, s.campaign, s.discount_code,
                                 s.shipping_carrier, s.shipping_method, s.tracking_number, s.tracking_status,
                                 s.tracking_status_at, s.shipped_at, s.created_at, s.updated_at, false))
    INTO _new, _stale, _changed
  FROM web_src s
  LEFT JOIN public.web_orders w ON w.shop_order_id = s.shop_order_id;

  -- ── a number now held by another shop id retires the old row ──
  UPDATE public.web_orders w
     SET deleted_in_shop_at = now()
    FROM web_src s
   WHERE w.order_number = s.order_number
     AND w.shop_order_id <> s.shop_order_id
     AND w.deleted_in_shop_at IS NULL;
  GET DIAGNOSTICS _retired = ROW_COUNT;

  -- ── the upsert ──
  DROP TABLE IF EXISTS pg_temp.web_acc;
  CREATE TEMP TABLE web_acc (shop_order_id integer PRIMARY KEY) ON COMMIT DROP;

  WITH up AS (
    INSERT INTO public.web_orders AS w (
      shop_order_id, order_number, status, payment_method, payment_status, total,
      shipping_total, discount_total, currency, city, phone, phone8, source, channel,
      traffic_source, campaign, discount_code, shipping_carrier, shipping_method,
      tracking_number, tracking_status, tracking_status_at, shipped_at, created_at, updated_at)
    SELECT
      s.shop_order_id, s.order_number, s.status, s.payment_method, s.payment_status, s.total,
      s.shipping_total, s.discount_total, s.currency, s.city, s.phone, s.phone8, s.source, s.channel,
      s.traffic_source, s.campaign, s.discount_code, s.shipping_carrier, s.shipping_method,
      s.tracking_number, s.tracking_status, s.tracking_status_at, s.shipped_at, s.created_at, s.updated_at
    FROM web_src s
    ORDER BY s.shop_order_id                     -- stable row-lock order across runs
    ON CONFLICT (shop_order_id) DO UPDATE SET
      order_number       = EXCLUDED.order_number,
      status             = EXCLUDED.status,
      payment_method     = EXCLUDED.payment_method,
      payment_status     = EXCLUDED.payment_status,
      total              = EXCLUDED.total,
      shipping_total     = EXCLUDED.shipping_total,
      discount_total     = EXCLUDED.discount_total,
      currency           = EXCLUDED.currency,
      city               = EXCLUDED.city,
      phone              = EXCLUDED.phone,
      phone8             = EXCLUDED.phone8,
      source             = EXCLUDED.source,
      channel            = EXCLUDED.channel,
      traffic_source     = EXCLUDED.traffic_source,
      campaign           = EXCLUDED.campaign,
      discount_code      = EXCLUDED.discount_code,
      shipping_carrier   = EXCLUDED.shipping_carrier,
      shipping_method    = EXCLUDED.shipping_method,
      tracking_number    = EXCLUDED.tracking_number,
      tracking_status    = EXCLUDED.tracking_status,
      tracking_status_at = EXCLUDED.tracking_status_at,
      shipped_at         = EXCLUDED.shipped_at,
      created_at         = EXCLUDED.created_at,
      updated_at         = EXCLUDED.updated_at,
      last_synced_at     = CASE
                             WHEN (w.order_number, w.status, w.payment_method, w.payment_status, w.total,
                                   w.shipping_total, w.discount_total, w.currency, w.city, w.phone,
                                   w.source, w.channel, w.traffic_source, w.campaign, w.discount_code,
                                   w.shipping_carrier, w.shipping_method, w.tracking_number,
                                   w.tracking_status, w.tracking_status_at, w.shipped_at, w.created_at,
                                   w.updated_at)
                                  IS DISTINCT FROM
                                  (EXCLUDED.order_number, EXCLUDED.status, EXCLUDED.payment_method,
                                   EXCLUDED.payment_status, EXCLUDED.total, EXCLUDED.shipping_total,
                                   EXCLUDED.discount_total, EXCLUDED.currency, EXCLUDED.city, EXCLUDED.phone,
                                   EXCLUDED.source, EXCLUDED.channel, EXCLUDED.traffic_source,
                                   EXCLUDED.campaign, EXCLUDED.discount_code, EXCLUDED.shipping_carrier,
                                   EXCLUDED.shipping_method, EXCLUDED.tracking_number,
                                   EXCLUDED.tracking_status, EXCLUDED.tracking_status_at,
                                   EXCLUDED.shipped_at, EXCLUDED.created_at, EXCLUDED.updated_at)
                             THEN now() ELSE w.last_synced_at END,
      last_seen_at       = now(),
      deleted_in_shop_at = NULL
    WHERE w.updated_at <= EXCLUDED.updated_at    -- never roll an order back
    RETURNING w.shop_order_id
  )
  INSERT INTO web_acc (shop_order_id) SELECT shop_order_id FROM up;
  GET DIAGNOSTICS _written = ROW_COUNT;

  -- ── the lines of every accepted order ──
  IF _items_received > 0 OR p_items_complete THEN
    DROP TABLE IF EXISTS pg_temp.web_isrc;
    CREATE TEMP TABLE web_isrc ON COMMIT DROP AS
    SELECT DISTINCT ON ((e->>'shop_item_id')::integer)
      (e->>'shop_item_id')::integer                     AS shop_item_id,
      (e->>'shop_order_id')::integer                    AS shop_order_id,
      nullif(e->>'product_id', '')::integer             AS product_id,
      nullif(e->>'variant_id', '')::integer             AS variant_id,
      coalesce(e->>'name', '')                          AS name,
      nullif(e->>'variant_label', '')                   AS variant_label,
      nullif(e->>'sku', '')                             AS sku,
      coalesce(nullif(e->>'quantity', '')::integer, 0)  AS quantity,
      coalesce(nullif(e->>'price', '')::numeric(12,2), 0) AS price,
      nullif(e->>'discount_allocated', '')::numeric(12,2) AS discount_allocated,
      coalesce(nullif(e->>'kind', ''), 'SALE')          AS kind,
      nullif(e->>'compare_at_price', '')::numeric(12,2) AS compare_at_price
    FROM jsonb_array_elements(p_items) e
    ORDER BY (e->>'shop_item_id')::integer;

    IF p_items_complete THEN
      DELETE FROM public.web_order_items i
       USING web_acc a
       WHERE i.shop_order_id = a.shop_order_id
         AND NOT EXISTS (SELECT 1 FROM web_isrc s WHERE s.shop_item_id = i.shop_item_id);
      GET DIAGNOSTICS _items_deleted = ROW_COUNT;
    END IF;

    INSERT INTO public.web_order_items AS i (
      shop_item_id, shop_order_id, product_id, variant_id, name, variant_label, sku,
      quantity, price, discount_allocated, kind, compare_at_price)
    SELECT s.shop_item_id, s.shop_order_id, s.product_id, s.variant_id, s.name, s.variant_label, s.sku,
           s.quantity, s.price, s.discount_allocated, s.kind, s.compare_at_price
    FROM web_isrc s
    JOIN web_acc a ON a.shop_order_id = s.shop_order_id
    ORDER BY s.shop_item_id
    ON CONFLICT (shop_item_id) DO UPDATE SET
      shop_order_id      = EXCLUDED.shop_order_id,
      product_id         = EXCLUDED.product_id,
      variant_id         = EXCLUDED.variant_id,
      name               = EXCLUDED.name,
      variant_label      = EXCLUDED.variant_label,
      sku                = EXCLUDED.sku,
      quantity           = EXCLUDED.quantity,
      price              = EXCLUDED.price,
      discount_allocated = EXCLUDED.discount_allocated,
      kind               = EXCLUDED.kind,
      compare_at_price   = EXCLUDED.compare_at_price,
      last_synced_at     = now()
    WHERE (i.shop_order_id, i.product_id, i.variant_id, i.name, i.variant_label, i.sku, i.quantity,
           i.price, i.discount_allocated, i.kind, i.compare_at_price)
          IS DISTINCT FROM
          (EXCLUDED.shop_order_id, EXCLUDED.product_id, EXCLUDED.variant_id, EXCLUDED.name,
           EXCLUDED.variant_label, EXCLUDED.sku, EXCLUDED.quantity, EXCLUDED.price,
           EXCLUDED.discount_allocated, EXCLUDED.kind, EXCLUDED.compare_at_price);
    GET DIAGNOSTICS _items_upserted = ROW_COUNT;
  END IF;

  RETURN jsonb_build_object(
    'received',       _received,
    'written',        _written,
    'new',            _new,
    'changed',        _changed,
    'stale',          _stale,
    'retired',        _retired,
    'items_received', _items_received,
    'items_upserted', _items_upserted,
    'items_deleted',  _items_deleted
  );
END;
$fn$;

COMMENT ON FUNCTION public.web_upsert_orders(jsonb, jsonb, boolean) IS
  'The only writer of web_orders / web_order_items. Refuses any row whose tenant_slug is not naturatherapy-mk or whose number is not OC-…/NTMK…; never rolls an order back to an older shop updated_at. Returns {received, written, new, changed, stale, retired, items_received, items_upserted, items_deleted}. Service role only.';

REVOKE ALL ON FUNCTION public.web_upsert_orders(jsonb, jsonb, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_upsert_orders(jsonb, jsonb, boolean) TO service_role;

-- ── 5. The MEX link (read-only toward mex_parcels) ──────────────────────────
-- Candidates, best first (newest parcel wins within a rule — a re-send):
--   tracking          mex_parcels.tracking_id = the waybill the shop recorded
--   sender_reference  mex_parcels.sender_reference = our order number (the
--                     shop sends its number as MEX's sender_reference)
--   order_number      mex_parcels.tracking_id = our order number (357 NTMK-
--                     shaped tracking ids exist in the register)
-- p_ids NULL → every live order created in the last p_recent_days days that
-- is unlinked or whose waybill no longer matches its link (a parcel often
-- reaches the register after the order reached us).
CREATE OR REPLACE FUNCTION public.web_link_mex_parcels(
  p_ids integer[] DEFAULT NULL,
  p_recent_days integer DEFAULT 60)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _scanned integer := 0;
  _linked  integer := 0;
BEGIN
  WITH scope AS (
    SELECT w.shop_order_id, w.order_number, w.tracking_number
    FROM public.web_orders w
    WHERE w.deleted_in_shop_at IS NULL
      AND CASE
            WHEN p_ids IS NOT NULL THEN w.shop_order_id = ANY (p_ids)
            ELSE (p_recent_days IS NULL OR w.created_at >= now() - make_interval(days => p_recent_days))
                 AND (w.mex_tracking_id IS NULL
                      OR (w.tracking_number IS NOT NULL AND w.mex_tracking_id IS DISTINCT FROM w.tracking_number))
          END
  ),
  cand AS (
    SELECT s.shop_order_id, c.tracking_id, c.method
    FROM scope s
    CROSS JOIN LATERAL (
      SELECT q.tracking_id, q.method
      FROM (
        SELECT p.tracking_id, 'tracking'::text AS method, 1 AS pri, p.created_at_mex
          FROM public.mex_parcels p
         WHERE s.tracking_number IS NOT NULL AND p.tracking_id = s.tracking_number
        UNION ALL
        SELECT p.tracking_id, 'sender_reference', 2, p.created_at_mex
          FROM public.mex_parcels p
         WHERE p.sender_reference = s.order_number
        UNION ALL
        SELECT p.tracking_id, 'order_number', 3, p.created_at_mex
          FROM public.mex_parcels p
         WHERE p.tracking_id = s.order_number
      ) q
      ORDER BY q.pri, q.created_at_mex DESC NULLS LAST, q.tracking_id DESC
      LIMIT 1
    ) c
  ),
  counted AS (SELECT count(*)::integer AS n FROM scope),
  upd AS (
    UPDATE public.web_orders w
       SET mex_tracking_id = c.tracking_id,
           mex_link_method = c.method,
           mex_linked_at   = now()
      FROM cand c
     WHERE w.shop_order_id = c.shop_order_id
       AND (w.mex_tracking_id, w.mex_link_method) IS DISTINCT FROM (c.tracking_id, c.method)
    RETURNING 1
  )
  SELECT (SELECT n FROM counted), (SELECT count(*)::integer FROM upd) INTO _scanned, _linked;

  RETURN jsonb_build_object('scanned', _scanned, 'linked', _linked);
END;
$fn$;

COMMENT ON FUNCTION public.web_link_mex_parcels(integer[], integer) IS
  'Links web_orders to their MEX parcel (tracking > sender_reference > order_number; newest parcel within a rule). Reads mex_parcels, never writes it. Returns {scanned, linked}. Service role only.';

REVOKE ALL ON FUNCTION public.web_link_mex_parcels(integer[], integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_link_mex_parcels(integer[], integer) TO service_role;

-- ── 6. Deletions, after a COMPLETE backfill ─────────────────────────────────
-- A backfill session reads every tenant-2 order and stamps last_seen_at.
-- Anything live that the session did not see (last_seen_at before the session
-- started) is gone from the shop. Guard: more than max(25, 2 %) candidates
-- means the read was incomplete (a broken export) — nothing is
-- marked and the guard is reported instead.
CREATE OR REPLACE FUNCTION public.web_mark_deleted(
  p_session_started_at timestamptz,
  p_shop_count integer DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _live   integer;
  _cand   integer;
  _marked integer := 0;
  _limit  integer;
BEGIN
  IF p_session_started_at IS NULL THEN
    RAISE EXCEPTION 'web_mark_deleted: session start is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT count(*)::integer INTO _live FROM public.web_orders WHERE deleted_in_shop_at IS NULL;
  SELECT count(*)::integer INTO _cand FROM public.web_orders
   WHERE deleted_in_shop_at IS NULL AND last_seen_at < p_session_started_at;
  _limit := greatest(25, ceil(_live * 0.02)::integer);

  IF _cand > _limit THEN
    RETURN jsonb_build_object('marked', 0, 'candidates', _cand, 'live', _live, 'limit', _limit,
                              'guard', 'tripped', 'shop_count', p_shop_count);
  END IF;

  UPDATE public.web_orders
     SET deleted_in_shop_at = now()
   WHERE deleted_in_shop_at IS NULL
     AND last_seen_at < p_session_started_at;
  GET DIAGNOSTICS _marked = ROW_COUNT;

  RETURN jsonb_build_object('marked', _marked, 'candidates', _cand, 'live', _live - _marked,
                            'limit', _limit, 'guard', 'ok', 'shop_count', p_shop_count);
END;
$fn$;

REVOKE ALL ON FUNCTION public.web_mark_deleted(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.web_mark_deleted(timestamptz, integer) TO service_role;

-- ── 7. The Overview's web block ─────────────────────────────────────────────
-- p_from / p_to_end follow the insights_* convention of the api function:
--   p_from    'YYYY-MM-DD' (Skopje midnight) or an ISO instant; NULL/'' = open
--   p_to_end  'YYYY-MM-DD' (the whole Skopje day, inclusive) or an ISO instant
--             inclusive to the SECOND — the api's skopjeRangeEnd() sends
--             23:59:59, which therefore covers up to the next midnight
--             exactly like the shop panel's exclusive end; NULL/'' = open
-- Orders are counted on their CREATED instant ("what happened to the orders
-- placed in this period, as of now" — the shop panel's cohort).
--
-- Returns {
--   meta, sync,
--   placed: {count, value_mkd},                  -- card_unpaid excluded
--   card_unpaid: {count, value_mkd},             -- failed card checkouts (not orders)
--   buckets: {awaiting, preparing, courier, delivered, returned, cancelled, no_record: {count, value_mkd}},
--   money: {collected_mkd, to_collect_mkd, lost_mkd, unrecorded_mkd, partially_refunded_count, refunds_mirrored:false},
--   split: {native: {count, value_mkd}, legacy: {count, value_mkd}},
--   courier_status: [{status, count}], preparing_waybill: {with_waybill, without_waybill},
--   delivery_days: {median, n},
--   mex: {linked, delivered, delivered_cod_mkd, returned, at_courier},   -- MEX facts of linked placed orders
--   mex_only: {count, delivered, delivered_cod_mkd, returned},            -- NTMK parcels no web order claims
--   non_mkd_count,
--   daily: [{d, placed_count, placed_value_mkd, delivered_count, delivered_mkd, collected_mkd}]
-- }
CREATE OR REPLACE FUNCTION public.insights_web_block(p_from text, p_to_end text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
AS $fn$
DECLARE
  _from timestamptz;
  _to   timestamptz;   -- exclusive
  _f    text := nullif(btrim(coalesce(p_from, '')), '');
  _t    text := nullif(btrim(coalesce(p_to_end, '')), '');
  _res  jsonb;
BEGIN
  IF _f IS NOT NULL THEN
    _from := CASE WHEN _f ~ '^\d{4}-\d{2}-\d{2}$'
                  THEN _f::date::timestamp AT TIME ZONE 'Europe/Skopje'
                  ELSE _f::timestamptz END;
  END IF;
  IF _t IS NOT NULL THEN
    _to := CASE WHEN _t ~ '^\d{4}-\d{2}-\d{2}$'
                THEN (_t::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje'
                ELSE date_trunc('second', _t::timestamptz) + interval '1 second' END;
  END IF;

  WITH base AS (
    SELECT w.*,
           public.web_order_outcome(w.status, w.payment_status, w.payment_method) AS bucket,
           public.web_order_money(w.status, w.payment_status)                      AS money,
           (w.created_at AT TIME ZONE 'Europe/Skopje')::date                       AS d
    FROM public.web_orders w
    WHERE w.deleted_in_shop_at IS NULL
      AND (_from IS NULL OR w.created_at >= _from)
      AND (_to   IS NULL OR w.created_at <  _to)
  ),
  placed AS (SELECT * FROM base WHERE bucket <> 'card_unpaid'),
  bucket_names(bucket, ord) AS (
    VALUES ('awaiting', 1), ('preparing', 2), ('courier', 3), ('delivered', 4),
           ('returned', 5), ('cancelled', 6), ('no_record', 7)
  ),
  bucket_agg AS (
    SELECT b.bucket,
           count(p.shop_order_id)::integer    AS n,
           coalesce(sum(p.total), 0)          AS v
    FROM bucket_names b
    LEFT JOIN placed p ON p.bucket = b.bucket
    GROUP BY b.bucket
  ),
  daily AS (
    SELECT p.d,
           count(*)::integer                                               AS placed_count,
           sum(p.total)                                                    AS placed_value,
           count(*) FILTER (WHERE p.bucket = 'delivered')::integer         AS delivered_count,
           coalesce(sum(p.total) FILTER (WHERE p.bucket = 'delivered'), 0) AS delivered_value,
           coalesce(sum(p.total) FILTER (WHERE p.money = 'collected'), 0)  AS collected_value
    FROM placed p
    GROUP BY p.d
  ),
  courier AS (
    SELECT coalesce(btrim(p.tracking_status), '') AS status, count(*)::integer AS n
    FROM placed p WHERE p.bucket = 'courier'
    GROUP BY 1
  ),
  linked AS (
    SELECT p.shop_order_id, m.status_id, m.cod_mkd, m.delivered_at, m.returned_at
    FROM placed p
    JOIN public.mex_parcels m ON m.tracking_id = p.mex_tracking_id
  ),
  mex_only AS (
    -- NTMK-referenced parcels created in the range that no web order claims
    -- and the CRM has not linked to one of its own orders.
    SELECT m.status_id, m.cod_mkd
    FROM public.mex_parcels m
    WHERE (m.sender_reference ~ '^NTMK[0-9]+$' OR m.tracking_id ~ '^NTMK[0-9]+$')
      AND m.order_id IS NULL
      AND (_from IS NULL OR m.created_at_mex >= _from)
      AND (_to   IS NULL OR m.created_at_mex <  _to)
      AND NOT EXISTS (SELECT 1 FROM public.web_orders w
                       WHERE w.mex_tracking_id = m.tracking_id
                          OR w.order_number = m.sender_reference
                          OR w.order_number = m.tracking_id)
  ),
  last_run AS (
    SELECT r.status, r.started_at, r.finished_at, r.error, r.warning, r.kind
    FROM public.web_sync_runs r
    ORDER BY r.started_at DESC
    LIMIT 1
  ),
  last_ok AS (
    SELECT max(r.finished_at) AS at FROM public.web_sync_runs r WHERE r.status IN ('ok', 'partial')
  )
  SELECT jsonb_build_object(
    'meta', jsonb_build_object(
      'from', _from, 'to_exclusive', _to, 'tz', 'Europe/Skopje', 'day_basis', 'created',
      'currency', 'MKD', 'generated_at', now()),
    'sync', jsonb_build_object(
      'last_ok_at',      (SELECT at FROM last_ok),
      'last_run_at',     (SELECT coalesce(finished_at, started_at) FROM last_run),
      'last_run_kind',   (SELECT kind FROM last_run),
      'last_run_status', (SELECT status FROM last_run),
      'last_error',      (SELECT error FROM last_run),
      'last_warning',    (SELECT warning FROM last_run),
      -- Shop rows web-sync refused to mirror (number not OC-…/NTMK…). The
      -- nightly sweep re-reads them, so a non-zero value persists until fixed.
      'rejected_24h',    (SELECT coalesce(max(r.rejected), 0)::integer FROM public.web_sync_runs r
                           WHERE r.started_at > now() - interval '26 hours'),
      'live_orders',     (SELECT count(*)::integer FROM public.web_orders WHERE deleted_in_shop_at IS NULL)),
    'placed', jsonb_build_object(
      'count',     (SELECT count(*)::integer FROM placed),
      'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed)),
    'card_unpaid', jsonb_build_object(
      'count',     (SELECT count(*)::integer FROM base WHERE bucket = 'card_unpaid'),
      'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM base WHERE bucket = 'card_unpaid')),
    'buckets', (SELECT jsonb_object_agg(bucket, jsonb_build_object('count', n, 'value_mkd', round(v, 2)))
                FROM bucket_agg),
    'money', jsonb_build_object(
      'collected_mkd',  (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'collected'),
      'to_collect_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'to_collect'),
      'lost_mkd',       (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'lost'),
      'unrecorded_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE money = 'unrecorded'),
      'partially_refunded_count',
                        (SELECT count(*)::integer FROM placed WHERE payment_status = 'PARTIALLY_REFUNDED'),
      'refunds_mirrored', false),
    'split', jsonb_build_object(
      'native', jsonb_build_object(
        'count',     (SELECT count(*)::integer FROM placed WHERE NOT is_legacy),
        'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE NOT is_legacy)),
      'legacy', jsonb_build_object(
        'count',     (SELECT count(*)::integer FROM placed WHERE is_legacy),
        'value_mkd', (SELECT round(coalesce(sum(total), 0), 2) FROM placed WHERE is_legacy))),
    'courier_status', coalesce((SELECT jsonb_agg(jsonb_build_object('status', status, 'count', n)
                                                 ORDER BY n DESC, status) FROM courier), '[]'::jsonb),
    'preparing_waybill', jsonb_build_object(
      'with_waybill',    (SELECT count(*)::integer FROM placed WHERE bucket = 'preparing' AND tracking_number IS NOT NULL),
      'without_waybill', (SELECT count(*)::integer FROM placed WHERE bucket = 'preparing' AND tracking_number IS NULL)),
    'delivery_days', (
      SELECT jsonb_build_object(
               'median', round((percentile_cont(0.5) WITHIN GROUP (
                          ORDER BY extract(epoch FROM (tracking_status_at - created_at)) / 86400))::numeric, 2),
               'n', count(*)::integer)
      FROM placed
      WHERE status = 'DELIVERED' AND tracking_status_at IS NOT NULL AND tracking_status_at > created_at),
    'mex', jsonb_build_object(
      'linked',            (SELECT count(*)::integer FROM linked),
      'delivered',         (SELECT count(*)::integer FROM linked WHERE status_id = 2),
      'delivered_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM linked WHERE status_id = 2),
      'returned',          (SELECT count(*)::integer FROM linked WHERE status_id = 7),
      'at_courier',        (SELECT count(*)::integer FROM linked WHERE status_id IS DISTINCT FROM 2
                                                                  AND status_id IS DISTINCT FROM 7)),
    'mex_only', jsonb_build_object(
      'count',             (SELECT count(*)::integer FROM mex_only),
      'delivered',         (SELECT count(*)::integer FROM mex_only WHERE status_id = 2),
      'delivered_cod_mkd', (SELECT coalesce(sum(cod_mkd), 0) FROM mex_only WHERE status_id = 2),
      'returned',          (SELECT count(*)::integer FROM mex_only WHERE status_id = 7)),
    'non_mkd_count', (SELECT count(*)::integer FROM placed WHERE currency IS DISTINCT FROM 'MKD'),
    'daily', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'd', to_char(d::timestamp, 'YYYY-MM-DD'),
               'placed_count', placed_count,
               'placed_value_mkd', round(placed_value, 2),
               'delivered_count', delivered_count,
               'delivered_mkd', round(delivered_value, 2),
               'collected_mkd', round(collected_value, 2)) ORDER BY d)
      FROM daily), '[]'::jsonb)
  ) INTO _res;

  RETURN _res;
END;
$fn$;

COMMENT ON FUNCTION public.insights_web_block(text, text) IS
  'naturatherapy.mk web block for the Overview (shop panel rules, card_unpaid excluded, day = created in Europe/Skopje, money in MKD). p_from = YYYY-MM-DD or ISO; p_to_end = YYYY-MM-DD (inclusive day) or ISO (inclusive to the second). Service role only — the api gates owners.';

REVOKE ALL ON FUNCTION public.insights_web_block(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.insights_web_block(text, text) TO service_role;

-- The read-only verification harness (scripts/verify-attribution.mjs C14)
-- calls the block through the Management API with read_only: true, which runs
-- as supabase_read_only_user. That role already reads every table
-- (pg_read_all_data), so EXECUTE on functions that only read widens nothing.
-- insights_web_block runs with the CALLER's rights, so the classifiers it
-- calls need the grant too. Conditional (same pattern as 20260936000000) so a
-- fresh local database without the platform role still migrates.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.insights_web_block(text, text)         TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.web_order_outcome(text, text, text)    TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.web_order_money(text, text)            TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.web_order_number_ok(text)              TO supabase_read_only_user;
  END IF;
END
$grant$;

NOTIFY pgrst, 'reload schema';
