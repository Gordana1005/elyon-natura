-- ============================================================================
-- STOCK — the physical count (попис) and MEX-driven stock movements
-- (2026-09-28, owner: stock must be solved "in the upcoming days")
--
-- Where stock stood on 28.09: the last physical count was 06.08 (every product
-- set to the 1.000 placeholder), the last deduction 20.08, and MEX has created
-- ~10.500 parcels since with nothing deducted. The CRM only moved stock when a
-- person pressed "shipped" / "returned"; since August the courier
-- (mex-reconcile) moves the orders, so nobody presses anything and stock
-- froze. This migration makes MEX the stock driver, as it already is the
-- money driver (rule 2026-08-12: MEX alone decides shipped / paid / returned).
--
-- ── 1. THE COUNT (попис) ────────────────────────────────────────────────────
-- stock_count_apply() saves ONE count event: per counted product the system
-- quantity it replaces, the counted quantity and the difference
-- (stock_count_lines); on-hand is SET to the count; every non-zero difference
-- is an inventory_logs movement 'count' (who, when, which count); and
-- app_settings.stock_counted_at = the count time (the trust anchor). The FIRST
-- count also sets stock_mex_movements.from — where the MEX ledger starts. A
-- product left blank is not part of the count and keeps its number. p_dry
-- returns the preview (the difference against the quantity at that moment)
-- and writes nothing. Written through the api only (owners / admin /
-- warehouse), audited there.
--
-- ── 2. THE MEX LEDGER ───────────────────────────────────────────────────────
-- Scope: every parcel in the register (mex_parcels, both accounts) created at
-- MEX on/after `from`, plus every parcel returned on/after `from`.
--   deduct   the parcel exists (label created, event time = created_at_mex):
--            its owner's product lines leave the shelf.
--   restock  MEX status 7 (event time = returned_at): the lines come back.
-- A parcel's owner — the foundation's rule (20260940000000): a live web order
-- claiming it wins (web_orders.mex_tracking_id); otherwise every real
-- (non-disposition) order holding it — the register's link
-- (mex_parcels.order_id; a re-send's older parcel keeps its order) or the
-- order naming it (orders.mex_tracking_id). The three parcels two orders hold
-- (owner ruling: both accurate) deduct both orders' lines. No owner (a
-- teleshop / shop parcel with no order yet) → recorded 'no_owner', nothing
-- moves; when collabBox / web-sync links it later the next run deducts it.
--
-- A LINE: order_items (product_id; else a reviewed product_aliases row; else a
-- name equal to exactly ONE active catalogue name — the Stock tab's fold) or,
-- for the web shop, web_order_items by name the same way. Its kind:
-- order_line_kind() (a reviewed alias) first, then the Stock tab's
-- unmistakable non-products by name (ПОЕН… loyalty points, ЗАБЕЛЕШКА notes,
-- флаер, ДОСТАВА). Those are 'not_stock'; a line that is a product but maps to
-- no catalogue product — or has an impossible quantity (≥ 100) — is
-- 'unmapped' and waits for review in the ledger; nothing is guessed.
-- FREE UNITS (a 0-price line, a web GIFT line) of a catalogue product ARE
-- deducted by default: the bottle leaves the shelf (ZINC / D3 gifts are ~1.500
-- units a month). stock_mex_movements.free_units = 'skip' stops that, and a
-- reviewed alias of kind 'gift' skips one name. (The owner's brief said "skip
-- gifts via order_line_kind": that is exactly the alias path.)
--
-- ── WHY A RECONCILING CRON, NOT A TRIGGER ───────────────────────────────────
-- stock_mex_apply() recomputes, for every parcel in scope, what the ledger
-- SHOULD hold (per parcel × owner × kind × product) and writes only the
-- difference against what it DOES hold. Re-running it is a no-op by
-- construction, and every late fact is caught by the next run: a parcel
-- linked days later (collabBox imports, web-sync), a parcel moved to another
-- order or unlinked (the old owner's lines are reversed, the new owner's
-- applied), an item line edited, an alias the owner approves (unmapped →
-- deducted), a status that leaves 7. A trigger would have to sit on five hot
-- tables (mex_parcels in 500-row sync batches, orders, order_items,
-- web_orders, web_order_items), fire before the lines exist, fail the sync it
-- rides on, and still need a sweep to catch up from the count to the switch.
-- Cost measured on live data 28.09 (since 20.08: 10.739 parcels, ~13.000
-- lines): 0,4–0,7 s for the desired state; a PGlite run of 12.000 parcels
-- applies in ~1 s and re-runs in ~0,4 s. pg_cron every 30 minutes (:12 / :42,
-- after mex-reconcile at :07 / :37 and web-sync at :03 / :33).
--
-- The ledger key is UNIQUE (tracking_id, owner_kind, owner_ref, kind) —
-- stock_mex_ledger, one row per parcel × owner × kind, its applied units per
-- product in stock_mex_ledger_lines. Each change is an inventory_logs row
-- (movement_type mex_deduct / mex_restock / mex_reverse, stock_ledger_id,
-- tracking_id), so on-hand = the last count + the movements after it, always
-- (scripts/verify-stock.mjs proves it).
--
-- A COUNT FREEZES THE PAST: a (parcel, product) whose event is older than that
-- product's last count never moves again — the count already saw the shelf.
-- So a recount of a few products needs no reset, a parcel created before the
-- count but registered after it is not deducted twice, and a parcel relinked
-- after a recount does not move the recounted product.
--
-- ── 3. DARK UNTIL THE OWNER SWITCHES IT ON ──────────────────────────────────
-- app_settings.stock_mex_movements = {enabled: false, from: null,
-- free_units: 'deduct'}. The count sets `from`; only an OWNER turns `enabled`
-- on (POST /api/stock/mex-movements, audited), and that first run catches up
-- every parcel since `from` — so parcels created between the count and the
-- switch are deducted at the switch, never lost. While it is off the cron
-- returns at once and writes nothing.
-- Once `from` is set (the first count) the api's OLD status-driven stock moves
-- (shipped → deduct, returned → restore, and their "insufficient stock"
-- refusal) stop — MEX owns stock from the count on, or a parcel would be
-- deducted twice (api index.ts stockByStatus()).
--
-- ── 4. TRUST ────────────────────────────────────────────────────────────────
-- insights_stock() is redefined from 20260941000500 with ONE change of
-- substance, the trust verdict: on-hand is trusted once a count exists AND the
-- MEX ledger is on AND it ran successfully in the last 3 hours. Days of cover,
-- out / low and the valuation (owners) follow that verdict as before; the
-- count's own movements ('count') and lines now count as "counted".
--
-- Security: the new tables carry no money and no PII, but they are written
-- only by these SECURITY DEFINER functions (service role: the api and
-- pg_cron) and read through the api — no client grants. stock_mex_movements
-- and stock_counted_at join the owner-only keys of
-- trg_app_settings_guard_owner_keys (no direct PostgREST write).
-- ============================================================================

SET LOCAL lock_timeout = '5s';

DO $dep$
BEGIN
  IF to_regclass('public.mex_parcels') IS NULL
     OR to_regclass('public.web_orders') IS NULL
     OR to_regclass('public.web_order_items') IS NULL
     OR to_regprocedure('public.product_key(text, text, uuid)') IS NULL
     OR to_regprocedure('public.order_line_kind(text, text)') IS NULL
     OR to_regprocedure('public.product_alias_norm(text)') IS NULL
     OR to_regprocedure('public.report_excluded_phone8s()') IS NULL
     OR to_regprocedure('public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean)') IS NULL
     OR to_regprocedure('public.tg_app_settings_guard_owner_keys()') IS NULL THEN
    RAISE EXCEPTION 'apply 20260934000100, 20260937000000, 20260939000200, 20260939000700, 20260940000000 and 20260941000500 first';
  END IF;
END
$dep$;

-- ── 0. A settings timestamp, parsed without ever raising ────────────────────
CREATE OR REPLACE FUNCTION public.stock_ts(p_value text)
RETURNS timestamptz
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
  SELECT CASE
           WHEN btrim(coalesce(p_value, '')) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            AND pg_input_is_valid(btrim(p_value), 'timestamptz')
           THEN btrim(p_value)::timestamptz
         END
$$;

COMMENT ON FUNCTION public.stock_ts(text) IS
  'A timestamp out of app_settings (stock_counted_at, stock_mex_movements.from) → timestamptz; NULL for anything unparseable, never raises. Migration 20260942000100.';

-- ── 1. The count ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_counts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counted_at      timestamptz NOT NULL DEFAULT now(),
  counted_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  counted_by_name text,
  note            text,
  products        integer NOT NULL,          -- products in this count
  changed         integer NOT NULL,          -- of them, with a difference
  units_before    bigint  NOT NULL,          -- Σ system quantity replaced
  units_after     bigint  NOT NULL,          -- Σ counted quantity
  anchored        boolean NOT NULL DEFAULT false   -- this count set stock_mex_movements.from
);

COMMENT ON TABLE public.stock_counts IS
  'One physical stock count (попис): who, when, how many products and units. Its lines are stock_count_lines; each non-zero difference is an inventory_logs movement ''count''. Written only by stock_count_apply() (the api, owners / admin / warehouse). Migration 20260942000100.';

CREATE TABLE IF NOT EXISTS public.stock_count_lines (
  count_id    uuid NOT NULL REFERENCES public.stock_counts(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  system_qty  integer NOT NULL,                                  -- on-hand the count replaced
  counted_qty integer NOT NULL
              CONSTRAINT stock_count_lines_counted_check CHECK (counted_qty BETWEEN 0 AND 1000000),
  diff        integer NOT NULL,                                  -- counted − system
  PRIMARY KEY (count_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_count_lines_product ON public.stock_count_lines (product_id);

COMMENT ON TABLE public.stock_count_lines IS
  'Per counted product: the system quantity replaced, the counted quantity and the difference. A product''s latest line is its count anchor: on-hand = counted_qty + every inventory_logs change after that count (scripts/verify-stock.mjs).';

-- ── 2. The MEX ledger ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_mex_ledger (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tracking_id   text NOT NULL,             -- mex_parcels.tracking_id (register rows are never deleted)
  owner_kind    text NOT NULL
                CONSTRAINT stock_mex_ledger_owner_kind_check CHECK (owner_kind IN ('order', 'web', 'none')),
  owner_ref     text NOT NULL,             -- orders.id · web_orders.shop_order_id · '' (none)
  kind          text NOT NULL
                CONSTRAINT stock_mex_ledger_kind_check CHECK (kind IN ('deduct', 'restock')),
  order_id      uuid,                      -- no FK on purpose: the ledger outlives a deleted order
  shop_order_id integer,
  owner_label   text,                      -- display_id / web order number, for people
  event_at      timestamptz NOT NULL,      -- MEX created_at (deduct) · returned_at (restock)
  state         text NOT NULL
                CONSTRAINT stock_mex_ledger_state_check
                CHECK (state IN ('applied', 'partial', 'unmapped', 'no_lines', 'no_owner', 'test_phone', 'released')),
  units_applied integer NOT NULL DEFAULT 0,
  unmapped      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name, qty, src, why}] product lines waiting for review
  not_stock     jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{name, qty, kind}] points / notes / delivery / gifts
  first_run_id  uuid,
  last_run_id   uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_mex_ledger_key UNIQUE (tracking_id, owner_kind, owner_ref, kind)
);

CREATE INDEX IF NOT EXISTS idx_stock_mex_ledger_state ON public.stock_mex_ledger (state, kind);
CREATE INDEX IF NOT EXISTS idx_stock_mex_ledger_order ON public.stock_mex_ledger (order_id) WHERE order_id IS NOT NULL;

COMMENT ON TABLE public.stock_mex_ledger IS
  'MEX-driven stock: one row per parcel × owner × kind (deduct | restock) — the UNIQUE key that makes a re-run a no-op. state: applied | partial (some lines unmapped) | unmapped | no_lines | no_owner (a MEX-only parcel) | test_phone | released (the owner no longer holds the parcel; its units were reversed). Written only by stock_mex_apply(). Migration 20260942000100.';

CREATE TABLE IF NOT EXISTS public.stock_mex_ledger_lines (
  ledger_id   uuid NOT NULL REFERENCES public.stock_mex_ledger(id) ON DELETE CASCADE,
  product_id  uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  qty_applied integer NOT NULL CONSTRAINT stock_mex_ledger_lines_qty_check CHECK (qty_applied >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (ledger_id, product_id)
);

CREATE INDEX IF NOT EXISTS idx_stock_mex_ledger_lines_product ON public.stock_mex_ledger_lines (product_id);

COMMENT ON TABLE public.stock_mex_ledger_lines IS
  'The units a ledger row has applied, per product (positive: units out for a deduct, units back for a restock). The inventory_logs rows carrying stock_ledger_id sum to exactly this (± by kind).';

CREATE TABLE IF NOT EXISTS public.stock_mex_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger        text NOT NULL DEFAULT 'cron',     -- cron | switch_on | manual
  status         text NOT NULL DEFAULT 'running'
                 CONSTRAINT stock_mex_runs_status_check CHECK (status IN ('running', 'ok', 'failed')),
  from_at        timestamptz,
  parcels        integer,        -- parcels in scope
  keys_changed   integer,        -- ledger rows written or changed
  movements      integer,        -- inventory_logs rows written
  units_out      integer,        -- deducted
  units_in       integer,        -- restocked
  units_reversed integer,        -- moved back (relink / unlink / edit / status left 7)
  frozen         integer,        -- (parcel, product) differences older than the product's last count — not moved
  unmapped_lines integer,
  skipped_parcels integer,       -- deduct events with nothing deducted (no owner / no lines / unmapped / test)
  error          text,
  started_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz,
  duration_ms    integer
);

CREATE INDEX IF NOT EXISTS idx_stock_mex_runs_started ON public.stock_mex_runs (started_at DESC);

COMMENT ON TABLE public.stock_mex_runs IS
  'One row per stock_mex_apply() run that did work (a switched-off tick writes nothing). The Stock trust verdict needs an ok run in the last 3 hours.';

-- The movement journal learns where a movement came from.
ALTER TABLE public.inventory_logs
  ADD COLUMN IF NOT EXISTS stock_count_id  uuid REFERENCES public.stock_counts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS stock_ledger_id uuid REFERENCES public.stock_mex_ledger(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS tracking_id     text;

CREATE INDEX IF NOT EXISTS idx_inventory_logs_stock_ledger
  ON public.inventory_logs (stock_ledger_id) WHERE stock_ledger_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_inventory_logs_product_created
  ON public.inventory_logs (product_id, created_at);

COMMENT ON COLUMN public.inventory_logs.stock_count_id IS
  'The stock count (попис) this movement belongs to (movement_type ''count''). Migration 20260942000100.';
COMMENT ON COLUMN public.inventory_logs.stock_ledger_id IS
  'The MEX ledger row this movement belongs to (movement_type mex_deduct | mex_restock | mex_reverse).';
COMMENT ON COLUMN public.inventory_logs.tracking_id IS
  'The MEX parcel behind a mex_* movement.';

-- No client access: written by the SECURITY DEFINER functions below (the api
-- and pg_cron), read through the api.
ALTER TABLE public.stock_counts           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_count_lines      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_mex_ledger       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_mex_ledger_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.stock_mex_runs         ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.stock_counts, public.stock_count_lines, public.stock_mex_ledger,
              public.stock_mex_ledger_lines, public.stock_mex_runs FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.stock_counts, public.stock_count_lines, public.stock_mex_ledger,
             public.stock_mex_ledger_lines, public.stock_mex_runs TO service_role;

-- ── 3. The settings — dark ──────────────────────────────────────────────────
INSERT INTO public.app_settings (key, value)
VALUES ('stock_mex_movements', '{"enabled": false, "from": null, "free_units": "deduct"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- Owner-only keys: an API session (anon / authenticated) may not write them
-- straight through PostgREST; the service role (the api, after its own
-- checks + audit) and the migration role still can. Recreated from the LIVE
-- definition (2026-09-28: no_parcel_rule only) plus the two stock keys.
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at'];
BEGIN
  IF current_user IN ('anon', 'authenticated')
     AND (CASE WHEN TG_OP = 'DELETE' THEN OLD.key ELSE NEW.key END = ANY (_guarded)
          OR (TG_OP = 'UPDATE' AND OLD.key = ANY (_guarded))) THEN
    RAISE EXCEPTION 'app_settings.% is changed only through its owners'' switch in the app',
                    CASE WHEN TG_OP = 'INSERT' THEN NEW.key ELSE OLD.key END
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$fn$;

REVOKE ALL ON FUNCTION public.tg_app_settings_guard_owner_keys() FROM PUBLIC, anon, authenticated;

-- ── 4. What the ledger SHOULD hold — one row per parcel event × owner × line ─
-- line_state: stock (a catalogue product, qty units) · unmapped (a product
-- line with no catalogue product, or an impossible quantity — for review) ·
-- not_stock (points / notes / flyers / delivery / reviewed gifts / zero
-- quantity) · no_lines (the owner has no lines) · no_owner (a MEX-only
-- parcel) · test_phone. The only reader of the business rules; the apply,
-- the preview, the health card and scripts/verify-stock.mjs all ask it.
-- scripts/verify-stock.mjs runs this body straight out of this file before
-- the migration is applied — keep the $desired$ tags and the parameter names.
CREATE OR REPLACE FUNCTION public.stock_mex_desired(p_from timestamptz, p_free_deduct boolean DEFAULT true)
RETURNS TABLE (
  tracking_id   text,
  kind          text,
  event_at      timestamptz,
  owner_kind    text,
  owner_ref     text,
  order_id      uuid,
  shop_order_id integer,
  owner_label   text,
  line_state    text,
  product_id    uuid,
  qty           integer,
  line_name     text,
  line_kind     text,
  src           text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $desired$
WITH
sc AS MATERIALIZED (       -- the parcels in scope
  SELECT p.tracking_id, p.status_id, p.created_at_mex, p.returned_at, p.order_id AS reg_order,
         coalesce(p.phone8 = ANY (public.report_excluded_phone8s()), false) AS test
  FROM public.mex_parcels p
  WHERE p.created_at_mex >= p_from OR p.returned_at >= p_from
),
ev AS MATERIALIZED (       -- the stock events they ask for
  SELECT sc.tracking_id, 'deduct'::text AS kind, sc.created_at_mex AS event_at, sc.test
  FROM sc WHERE sc.created_at_mex >= p_from
  UNION ALL
  SELECT sc.tracking_id, 'restock'::text, sc.returned_at, sc.test
  FROM sc WHERE sc.status_id = 7 AND sc.returned_at >= p_from
),
wo AS MATERIALIZED (       -- 1. a live web order's claim wins
  SELECT DISTINCT w.mex_tracking_id AS tr, w.shop_order_id, w.order_number
  FROM public.web_orders w
  JOIN sc ON sc.tracking_id = w.mex_tracking_id
  WHERE w.deleted_in_shop_at IS NULL AND NOT sc.test
),
oo AS MATERIALIZED (       -- 2. else every real order holding it: the register's link, or the order naming it
  SELECT DISTINCT x.tr, x.oid, x.display_id,
         CASE WHEN x.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src
  FROM (SELECT sc.tracking_id AS tr, o.id AS oid, o.display_id, o.sale_source, o.sale_source_detail
          FROM sc JOIN public.orders o ON o.mex_tracking_id = sc.tracking_id
         WHERE NOT sc.test
        UNION ALL
        SELECT sc.tracking_id, o.id, o.display_id, o.sale_source, o.sale_source_detail
          FROM sc JOIN public.orders o ON o.id = sc.reg_order
         WHERE NOT sc.test) x
  WHERE x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND x.tr NOT IN (SELECT wo.tr FROM wo)
),
own AS MATERIALIZED (
  SELECT oo.tr, 'order'::text AS owner_kind, oo.oid::text AS owner_ref, oo.oid AS order_id,
         NULL::integer AS shop_order_id, oo.display_id AS owner_label
  FROM oo
  UNION ALL
  SELECT wo.tr, 'web'::text, wo.shop_order_id::text, NULL::uuid, wo.shop_order_id, wo.order_number
  FROM wo
),
ln AS MATERIALIZED (       -- every item line of every owner
  SELECT oo.tr, 'order'::text AS owner_kind, oo.oid::text AS owner_ref, oo.src,
         i.product_id AS pid, coalesce(i.product_name, '') AS nm, NULL::text AS wk,
         coalesce(i.price_per_unit, 0) AS price, coalesce(i.quantity, 0) AS q
  FROM oo JOIN public.order_items i ON i.order_id = oo.oid
  UNION ALL
  -- an order with no item rows: its own single product (the api's legacy path)
  SELECT oo.tr, 'order'::text, oo.oid::text, oo.src,
         o.product_id, coalesce(o.product_name, ''), NULL::text,
         coalesce(o.price, 0), coalesce(o.quantity, 1)
  FROM oo JOIN public.orders o ON o.id = oo.oid
  WHERE NOT EXISTS (SELECT 1 FROM public.order_items i WHERE i.order_id = oo.oid)
    AND (o.product_id IS NOT NULL OR nullif(btrim(o.product_name), '') IS NOT NULL)
  UNION ALL
  SELECT wo.tr, 'web'::text, wo.shop_order_id::text, 'web'::text,
         NULL::uuid, coalesce(i.name, ''), i.kind,
         coalesce(i.price, 0), coalesce(i.quantity, 0)
  FROM wo JOIN public.web_order_items i ON i.shop_order_id = wo.shop_order_id
),
cat AS MATERIALIZED (      -- active catalogue names: a line equal to exactly ONE of them is that product
  SELECT public.product_alias_norm(p.name) AS norm, (array_agg(p.id))[1] AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
dn AS MATERIALIZED (       -- each distinct line text ONCE: its reviewed alias (product and kind)
  SELECT d.src, d.nm, d.norm, k.ak,
         CASE WHEN k.pk LIKE 'p:%' THEN substr(k.pk, 3)::uuid END AS alias_pid
  FROM (SELECT DISTINCT ln.src, ln.nm, public.product_alias_norm(ln.nm) AS norm FROM ln) d
  CROSS JOIN LATERAL (SELECT public.product_key(d.src, d.nm, NULL) AS pk,
                             public.order_line_kind(d.src, d.nm) AS ak) k
),
lk AS MATERIALIZED (       -- each line: its catalogue product and its kind
  SELECT ln.*,
         coalesce(ln.pid, dn.alias_pid, CASE WHEN c.n = 1 THEN c.id END) AS product_id,
         CASE WHEN dn.ak <> 'product'                               THEN dn.ak
              WHEN lower(ln.nm) ~ '^\s*(поен|poen)'                  THEN 'loyalty_point'
              WHEN lower(ln.nm) ~ '(забелешка|zabeleska|zabeleshka)' THEN 'note'
              WHEN lower(ln.nm) ~ '^\s*(флаер|flaer|flyer)'          THEN 'flyer'
              WHEN lower(ln.nm) ~ '^\s*(достава|dostava)'            THEN 'delivery'
              WHEN ln.q <= 0                                         THEN 'zero_quantity'
              WHEN ln.q >= 100                                       THEN 'bad_quantity'
              WHEN NOT coalesce(p_free_deduct, true) AND (ln.wk = 'GIFT' OR ln.price <= 0) THEN 'gift'
              ELSE 'product' END AS lkind
  FROM ln
  JOIN dn ON dn.src = ln.src AND dn.nm = ln.nm      -- a HASH join (nm is never NULL here)
  LEFT JOIN cat c ON c.norm = dn.norm
)
-- a parcel event × each of its owners × each of their lines
SELECT ev.tracking_id, ev.kind, ev.event_at,
       own.owner_kind, own.owner_ref, own.order_id, own.shop_order_id, own.owner_label,
       CASE WHEN lk.tr IS NULL                                        THEN 'no_lines'
            WHEN lk.lkind = 'product' AND lk.product_id IS NOT NULL   THEN 'stock'
            WHEN lk.lkind IN ('product', 'bad_quantity')              THEN 'unmapped'
            ELSE 'not_stock' END,
       CASE WHEN lk.lkind = 'product' THEN lk.product_id END,
       lk.q::integer, lk.nm, lk.lkind, lk.src
FROM ev
JOIN own ON own.tr = ev.tracking_id
LEFT JOIN lk ON lk.tr = own.tr AND lk.owner_kind = own.owner_kind AND lk.owner_ref = own.owner_ref
UNION ALL
-- a parcel event nobody owns (a MEX-only parcel), or a test phone's
SELECT ev.tracking_id, ev.kind, ev.event_at,
       'none'::text, ''::text, NULL::uuid, NULL::integer, NULL::text,
       CASE WHEN ev.test THEN 'test_phone' ELSE 'no_owner' END,
       NULL::uuid, NULL::integer, NULL::text, NULL::text, NULL::text
FROM ev
WHERE ev.test OR ev.tracking_id NOT IN (SELECT own.tr FROM own)
$desired$;

COMMENT ON FUNCTION public.stock_mex_desired(timestamptz, boolean) IS
  'What the MEX stock ledger SHOULD hold since p_from: one row per parcel event (deduct = created at MEX, restock = status 7) × owner (web claim wins, else every real order holding the parcel) × item line, with line_state stock | unmapped | not_stock | no_lines | no_owner | test_phone. p_free_deduct = false treats 0-price / GIFT lines as gifts (not stock). Migration 20260942000100.';

-- ── 5. What would move now — desired against applied, per product ──────────
-- One row per (parcel, owner, kind, product) whose applied units differ from
-- the desired ones. frozen = the event is older than the product's last
-- count: it is never moved (delta 0). Read by the preview, the health card
-- and scripts/verify-stock.mjs; stock_mex_apply() runs the same join over
-- its own snapshot of stock_mex_desired() — KEEP THE TWO IN STEP.
CREATE OR REPLACE FUNCTION public.stock_mex_pending(p_from timestamptz, p_free_deduct boolean DEFAULT true)
RETURNS TABLE (
  tracking_id     text,
  kind            text,
  owner_kind      text,
  owner_ref       text,
  owner_label     text,
  event_at        timestamptz,
  ledger_id       uuid,
  product_id      uuid,
  desired         integer,
  applied         integer,
  last_counted_at timestamptz,
  frozen          boolean,
  delta           integer)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $pending$
WITH
d AS (
  SELECT x.tracking_id, x.kind, x.owner_kind, x.owner_ref, max(x.owner_label) AS owner_label,
         max(x.event_at) AS event_at, x.product_id, sum(x.qty)::integer AS q
  FROM public.stock_mex_desired(p_from, p_free_deduct) x
  WHERE x.line_state = 'stock'
  GROUP BY x.tracking_id, x.kind, x.owner_kind, x.owner_ref, x.product_id
),
a AS (                     -- applied, for the parcels in scope only (an older parcel is never touched)
  SELECT h.id AS ledger_id, h.tracking_id, h.kind, h.owner_kind, h.owner_ref, h.owner_label, h.event_at,
         l.product_id, l.qty_applied
  FROM public.stock_mex_ledger h
  JOIN public.stock_mex_ledger_lines l ON l.ledger_id = h.id
  JOIN public.mex_parcels p ON p.tracking_id = h.tracking_id
  WHERE (p.created_at_mex >= p_from OR p.returned_at >= p_from)
    AND l.qty_applied <> 0
),
lc AS (
  SELECT l.product_id, max(c.counted_at) AS last_counted_at
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.count_id
  GROUP BY l.product_id
),
j AS (
  SELECT coalesce(d.tracking_id, a.tracking_id) AS tracking_id, coalesce(d.kind, a.kind) AS kind,
         coalesce(d.owner_kind, a.owner_kind) AS owner_kind, coalesce(d.owner_ref, a.owner_ref) AS owner_ref,
         coalesce(d.owner_label, a.owner_label) AS owner_label, coalesce(d.event_at, a.event_at) AS event_at,
         a.ledger_id, coalesce(d.product_id, a.product_id) AS product_id,
         coalesce(d.q, 0) AS desired, coalesce(a.qty_applied, 0) AS applied
  FROM d
  FULL JOIN a ON a.tracking_id = d.tracking_id AND a.kind = d.kind AND a.owner_kind = d.owner_kind
             AND a.owner_ref = d.owner_ref AND a.product_id = d.product_id
)
SELECT j.tracking_id, j.kind, j.owner_kind, j.owner_ref, j.owner_label, j.event_at,
       coalesce(j.ledger_id, h.id), j.product_id, j.desired, j.applied, lc.last_counted_at,
       coalesce(j.event_at < lc.last_counted_at, false),
       CASE WHEN j.event_at < lc.last_counted_at THEN 0 ELSE j.desired - j.applied END
FROM j
LEFT JOIN public.stock_mex_ledger h
       ON j.ledger_id IS NULL AND h.tracking_id = j.tracking_id AND h.owner_kind = j.owner_kind
      AND h.owner_ref = j.owner_ref AND h.kind = j.kind
LEFT JOIN lc ON lc.product_id = j.product_id
WHERE j.desired <> j.applied
$pending$;

COMMENT ON FUNCTION public.stock_mex_pending(timestamptz, boolean) IS
  'The stock the MEX ledger would still move: per (parcel, owner, kind, product) desired vs applied units; frozen (delta 0) when the event is older than the product''s last count. Empty right after a run. Migration 20260942000100.';

-- ── 6. The apply — pg_cron every 30 minutes, and once at the owner's switch ─
-- Returns {ok, run_id, parcels, keys_changed, movements, units_out, units_in,
-- units_reversed, frozen, unmapped_lines, skipped_parcels} or {ok, skipped:
-- disabled | no_from | busy}. Switched off it reads one settings row and
-- returns. One run at a time (a transaction-level advisory lock that
-- stock_count_apply() also takes, so a count and a run never interleave).
-- Products are locked FOR NO KEY UPDATE (order_items' foreign-key checks
-- keep working while a run holds them).
CREATE OR REPLACE FUNCTION public.stock_mex_apply(p_trigger text DEFAULT 'cron')
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_set      jsonb;
  v_from     timestamptz;
  v_free     boolean;
  v_run      uuid;
  v_t0       timestamptz := clock_timestamp();
  v_parcels  integer := 0;
  v_keys     integer := 0;
  v_rel      integer := 0;
  v_moves    integer := 0;
  v_out      integer := 0;
  v_in       integer := 0;
  v_rev      integer := 0;
  v_frozen   integer := 0;
  v_unmapped integer := 0;
  v_skipped  integer := 0;
  v_err      text;
BEGIN
  SELECT a.value INTO v_set FROM public.app_settings a WHERE a.key = 'stock_mex_movements';
  IF coalesce(v_set ->> 'enabled', 'false') <> 'true' THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'disabled');
  END IF;
  v_from := public.stock_ts(v_set ->> 'from');
  IF v_from IS NULL THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'no_from');
  END IF;
  v_free := coalesce(v_set ->> 'free_units', 'deduct') <> 'skip';
  IF NOT pg_try_advisory_xact_lock(hashtext('public.stock_mex_apply')) THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'busy');
  END IF;

  INSERT INTO public.stock_mex_runs (trigger, from_at)
  VALUES (left(coalesce(p_trigger, 'cron'), 40), v_from)
  RETURNING id INTO v_run;

  BEGIN
    -- ONE snapshot of the desired state for the whole run.
    DROP TABLE IF EXISTS pg_temp._smd;
    CREATE TEMP TABLE _smd ON COMMIT DROP AS
      SELECT * FROM public.stock_mex_desired(v_from, v_free);
    DROP TABLE IF EXISTS pg_temp._sms;
    CREATE TEMP TABLE _sms ON COMMIT DROP AS          -- the parcels in scope
      SELECT p.tracking_id FROM public.mex_parcels p
      WHERE p.created_at_mex >= v_from OR p.returned_at >= v_from;
    -- a fresh temp table has no statistics: without them the planner may pick
    -- nested loops for the anti-join below (12k × 15k rows)
    ANALYZE pg_temp._smd;
    ANALYZE pg_temp._sms;
    SELECT count(*) INTO v_parcels FROM pg_temp._sms;

    -- 1. one ledger row per parcel × owner × kind, its state and review lists
    WITH h AS (
      SELECT d.tracking_id, d.owner_kind, d.owner_ref, d.kind,
             max(d.event_at) AS event_at,
             (array_agg(d.order_id) FILTER (WHERE d.order_id IS NOT NULL))[1] AS order_id,
             max(d.shop_order_id) AS shop_order_id,
             max(d.owner_label) AS owner_label,
             count(*) FILTER (WHERE d.line_state = 'stock')    AS n_stock,
             count(*) FILTER (WHERE d.line_state = 'unmapped') AS n_unm,
             bool_or(d.line_state = 'no_owner')   AS no_owner,
             bool_or(d.line_state = 'test_phone') AS test,
             coalesce(jsonb_agg(jsonb_build_object('name', d.line_name, 'qty', d.qty, 'src', d.src, 'why', d.line_kind)
                                ORDER BY d.line_name, d.qty) FILTER (WHERE d.line_state = 'unmapped'), '[]'::jsonb) AS unm,
             coalesce(jsonb_agg(jsonb_build_object('name', d.line_name, 'qty', d.qty, 'kind', d.line_kind)
                                ORDER BY d.line_name, d.qty) FILTER (WHERE d.line_state = 'not_stock'), '[]'::jsonb) AS ns
      FROM pg_temp._smd d
      GROUP BY d.tracking_id, d.owner_kind, d.owner_ref, d.kind
    )
    INSERT INTO public.stock_mex_ledger AS l
      (tracking_id, owner_kind, owner_ref, kind, order_id, shop_order_id, owner_label, event_at,
       state, unmapped, not_stock, first_run_id, last_run_id)
    SELECT h.tracking_id, h.owner_kind, h.owner_ref, h.kind, h.order_id, h.shop_order_id, h.owner_label, h.event_at,
           CASE WHEN h.test THEN 'test_phone'
                WHEN h.no_owner THEN 'no_owner'
                WHEN h.n_stock > 0 AND h.n_unm > 0 THEN 'partial'
                WHEN h.n_stock > 0 THEN 'applied'
                WHEN h.n_unm > 0 THEN 'unmapped'
                ELSE 'no_lines' END,
           h.unm, h.ns, v_run, v_run
    FROM h
    ORDER BY h.tracking_id, h.owner_kind, h.owner_ref, h.kind
    ON CONFLICT ON CONSTRAINT stock_mex_ledger_key DO UPDATE SET
      order_id      = EXCLUDED.order_id,
      shop_order_id = EXCLUDED.shop_order_id,
      owner_label   = EXCLUDED.owner_label,
      event_at      = EXCLUDED.event_at,
      state         = EXCLUDED.state,
      unmapped      = EXCLUDED.unmapped,
      not_stock     = EXCLUDED.not_stock,
      last_run_id   = v_run,
      updated_at    = now()
    WHERE (l.order_id, l.shop_order_id, l.owner_label, l.event_at, l.state, l.unmapped, l.not_stock)
          IS DISTINCT FROM
          (EXCLUDED.order_id, EXCLUDED.shop_order_id, EXCLUDED.owner_label, EXCLUDED.event_at,
           EXCLUDED.state, EXCLUDED.unmapped, EXCLUDED.not_stock);
    GET DIAGNOSTICS v_keys = ROW_COUNT;

    -- 2. an owner that no longer holds its parcel (moved to another order,
    --    unlinked, a web claim that won, a status that left 7): released —
    --    its units are reversed below.
    UPDATE public.stock_mex_ledger l
       SET state = 'released', unmapped = '[]'::jsonb, not_stock = '[]'::jsonb,
           last_run_id = v_run, updated_at = now()
     WHERE l.state <> 'released'
       AND l.tracking_id IN (SELECT s.tracking_id FROM pg_temp._sms s)
       AND NOT EXISTS (SELECT 1 FROM pg_temp._smd d
                        WHERE d.tracking_id = l.tracking_id AND d.owner_kind = l.owner_kind
                          AND d.owner_ref = l.owner_ref AND d.kind = l.kind);
    GET DIAGNOSTICS v_rel = ROW_COUNT;
    v_keys := v_keys + v_rel;

    -- 3. desired vs applied per product (the join of stock_mex_pending over
    --    this run's snapshot — KEEP IN STEP)
    DROP TABLE IF EXISTS pg_temp._smx;
    CREATE TEMP TABLE _smx ON COMMIT DROP AS
    WITH
    d AS (
      SELECT x.tracking_id, x.kind, x.owner_kind, x.owner_ref, x.product_id, sum(x.qty)::integer AS q
      FROM pg_temp._smd x
      WHERE x.line_state = 'stock'
      GROUP BY x.tracking_id, x.kind, x.owner_kind, x.owner_ref, x.product_id
    ),
    dd AS (                -- every desired key has its ledger row since step 1
      SELECT h.id AS ledger_id, d.product_id, d.q
      FROM d
      JOIN public.stock_mex_ledger h
        ON h.tracking_id = d.tracking_id AND h.owner_kind = d.owner_kind
       AND h.owner_ref = d.owner_ref AND h.kind = d.kind
    ),
    a AS (
      SELECT l.ledger_id, l.product_id, l.qty_applied
      FROM public.stock_mex_ledger_lines l
      JOIN public.stock_mex_ledger h ON h.id = l.ledger_id
      WHERE h.tracking_id IN (SELECT s.tracking_id FROM pg_temp._sms s)
        AND l.qty_applied <> 0
    ),
    lc AS (
      SELECT l.product_id, max(c.counted_at) AS last_counted_at
      FROM public.stock_count_lines l
      JOIN public.stock_counts c ON c.id = l.count_id
      GROUP BY l.product_id
    ),
    j AS (
      SELECT coalesce(dd.ledger_id, a.ledger_id) AS ledger_id, coalesce(dd.product_id, a.product_id) AS product_id,
             coalesce(dd.q, 0) AS desired, coalesce(a.qty_applied, 0) AS applied
      FROM dd
      FULL JOIN a ON a.ledger_id = dd.ledger_id AND a.product_id = dd.product_id
    )
    SELECT j.ledger_id, j.product_id, j.desired, j.applied,
           h.tracking_id, h.kind, h.event_at, h.owner_label,
           coalesce(h.event_at < lc.last_counted_at, false) AS frozen,
           -- the stock change: a deduct takes units out, a restock puts them back
           CASE WHEN h.kind = 'deduct' THEN j.applied - j.desired ELSE j.desired - j.applied END AS chg
    FROM j
    JOIN public.stock_mex_ledger h ON h.id = j.ledger_id
    LEFT JOIN lc ON lc.product_id = j.product_id
    WHERE j.desired <> j.applied;

    ANALYZE pg_temp._smx;
    SELECT count(*) INTO v_frozen FROM pg_temp._smx x WHERE x.frozen;

    -- 4. lock what moves, then write the movements (running before / after
    --    per product, in event order), the products and the applied units
    PERFORM 1 FROM public.products p
     WHERE p.id IN (SELECT x.product_id FROM pg_temp._smx x WHERE NOT x.frozen)
     ORDER BY p.id
       FOR NO KEY UPDATE;

    WITH mv AS (
      SELECT x.*,
             p.stock_quantity + sum(x.chg) OVER (PARTITION BY x.product_id
                                                 ORDER BY x.event_at, x.tracking_id, x.kind, x.ledger_id
                                                 ROWS UNBOUNDED PRECEDING) AS new_stock
      FROM pg_temp._smx x
      JOIN public.products p ON p.id = x.product_id
      WHERE NOT x.frozen
    )
    INSERT INTO public.inventory_logs
      (product_id, change_amount, previous_stock, new_stock, reason, movement_type, user_id, notes,
       stock_ledger_id, tracking_id)
    SELECT mv.product_id, mv.chg, mv.new_stock - mv.chg, mv.new_stock,
           CASE WHEN mv.kind = 'deduct'  AND mv.chg < 0 THEN 'order_deduction'
                WHEN mv.kind = 'restock' AND mv.chg > 0 THEN 'order_return'
                ELSE 'mex_relink' END,
           CASE WHEN mv.kind = 'deduct'  AND mv.chg < 0 THEN 'mex_deduct'
                WHEN mv.kind = 'restock' AND mv.chg > 0 THEN 'mex_restock'
                ELSE 'mex_reverse' END,
           NULL,
           'MEX ' || mv.tracking_id || coalesce(' · ' || mv.owner_label, ''),
           mv.ledger_id, mv.tracking_id
    FROM mv
    ORDER BY mv.product_id, mv.event_at, mv.tracking_id, mv.kind, mv.ledger_id;
    GET DIAGNOSTICS v_moves = ROW_COUNT;

    UPDATE public.products p
       SET stock_quantity = p.stock_quantity + s.chg
      FROM (SELECT x.product_id, sum(x.chg)::integer AS chg
              FROM pg_temp._smx x WHERE NOT x.frozen
             GROUP BY x.product_id) s
     WHERE p.id = s.product_id AND s.chg <> 0;

    INSERT INTO public.stock_mex_ledger_lines AS l (ledger_id, product_id, qty_applied)
    SELECT x.ledger_id, x.product_id, x.desired FROM pg_temp._smx x WHERE NOT x.frozen
    ORDER BY x.ledger_id, x.product_id
    ON CONFLICT (ledger_id, product_id) DO UPDATE SET qty_applied = EXCLUDED.qty_applied, updated_at = now();

    UPDATE public.stock_mex_ledger h
       SET units_applied = s.u, last_run_id = v_run, updated_at = now()
      FROM (SELECT l.ledger_id, sum(l.qty_applied)::integer AS u
              FROM public.stock_mex_ledger_lines l
             WHERE l.ledger_id IN (SELECT x.ledger_id FROM pg_temp._smx x WHERE NOT x.frozen)
             GROUP BY l.ledger_id) s
     WHERE h.id = s.ledger_id AND h.units_applied IS DISTINCT FROM s.u;

    SELECT coalesce(-sum(x.chg) FILTER (WHERE x.kind = 'deduct'  AND x.chg < 0), 0),
           coalesce( sum(x.chg) FILTER (WHERE x.kind = 'restock' AND x.chg > 0), 0),
           coalesce( sum(abs(x.chg)) FILTER (WHERE (x.kind = 'deduct' AND x.chg > 0)
                                                OR (x.kind = 'restock' AND x.chg < 0)), 0)
      INTO v_out, v_in, v_rev
      FROM pg_temp._smx x WHERE NOT x.frozen;

    SELECT count(*) FILTER (WHERE d.line_state = 'unmapped') INTO v_unmapped FROM pg_temp._smd d;
    SELECT count(*) INTO v_skipped
      FROM (SELECT d.tracking_id
              FROM pg_temp._smd d
             WHERE d.kind = 'deduct'
             GROUP BY d.tracking_id
            HAVING count(*) FILTER (WHERE d.line_state = 'stock') = 0) z;

    UPDATE public.stock_mex_runs
       SET status = 'ok', parcels = v_parcels, keys_changed = v_keys, movements = v_moves,
           units_out = v_out, units_in = v_in, units_reversed = v_rev, frozen = v_frozen,
           unmapped_lines = v_unmapped, skipped_parcels = v_skipped,
           finished_at = clock_timestamp(),
           duration_ms = (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer
     WHERE id = v_run;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    UPDATE public.stock_mex_runs
       SET status = 'failed', error = left(v_err, 1000), finished_at = clock_timestamp(),
           duration_ms = (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer
     WHERE id = v_run;
    RETURN jsonb_build_object('ok', false, 'run_id', v_run, 'error', v_err);
  END;

  -- quiet runs are not worth keeping for long
  DELETE FROM public.stock_mex_runs r
   WHERE r.started_at < now() - interval '60 days' AND coalesce(r.movements, 0) = 0 AND r.status = 'ok';

  RETURN jsonb_build_object(
    'ok', true, 'run_id', v_run, 'parcels', v_parcels, 'keys_changed', v_keys, 'movements', v_moves,
    'units_out', v_out, 'units_in', v_in, 'units_reversed', v_rev, 'frozen', v_frozen,
    'unmapped_lines', v_unmapped, 'skipped_parcels', v_skipped);
END;
$fn$;

COMMENT ON FUNCTION public.stock_mex_apply(text) IS
  'The MEX stock ledger run (pg_cron stock-mex-apply every 30 min; the api at the owner''s switch): reconciles stock_mex_ledger with stock_mex_desired() — new parcels deducted, returns restocked, released owners reversed, each change an inventory_logs row — and moves products.stock_quantity by exactly the same amounts. Idempotent. Off (stock_mex_movements.enabled = false) it returns at once. Migration 20260942000100.';

-- ── 7. The count (попис) ────────────────────────────────────────────────────
-- p_lines = [{product_id, counted}], counted an integer 0 … 1.000.000, each
-- product once. p_dry → the preview against the quantities of this moment,
-- nothing written. Otherwise: one stock_counts row, its lines, a 'count'
-- movement per non-zero difference, on-hand set, stock_counted_at = now and,
-- the first time, stock_mex_movements.from = now. Returns {ok, dry, count_id,
-- counted_at, products, changed, units_before, units_after, up, down,
-- not_counted, anchored, from, lines:[{product_id, name, sku, system,
-- counted, diff}]} or {ok: false, error}.
CREATE OR REPLACE FUNCTION public.stock_count_apply(
  p_lines      jsonb,
  p_actor      uuid,
  p_actor_name text    DEFAULT NULL,
  p_note       text    DEFAULT NULL,
  p_dry        boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_bad    text;
  v_now    timestamptz := now();
  v_count  uuid;
  v_set    jsonb;
  v_from   timestamptz;
  v_anchor boolean := false;
  v_sum    record;
  v_lines  jsonb;
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 500), '');
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lines_required');
  END IF;
  IF jsonb_array_length(p_lines) > 5000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_lines');
  END IF;

  WITH x AS (
    SELECT jsonb_typeof(e) AS t, e ->> 'product_id' AS pid,
           CASE WHEN jsonb_typeof(e -> 'counted') = 'number' THEN (e ->> 'counted')::numeric END AS c
    FROM jsonb_array_elements(p_lines) e
  )
  SELECT CASE
           WHEN count(*) FILTER (WHERE x.t <> 'object') > 0 THEN 'bad_line'
           WHEN count(*) FILTER (WHERE x.pid IS NULL
                                    OR x.pid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') > 0
             THEN 'bad_product_id'
           WHEN count(*) FILTER (WHERE x.c IS NULL OR x.c <> trunc(x.c) OR x.c < 0 OR x.c > 1000000) > 0
             THEN 'bad_quantity'
           WHEN count(DISTINCT lower(x.pid)) <> count(*) THEN 'duplicate_product'
         END
    INTO v_bad
    FROM x;
  IF v_bad IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_bad);
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_lines) e
              WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = (e ->> 'product_id')::uuid)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_product');
  END IF;

  IF NOT coalesce(p_dry, false) THEN
    -- never interleave with a MEX ledger run, then hold the counted products
    PERFORM pg_advisory_xact_lock(hashtext('public.stock_mex_apply'));
    PERFORM 1 FROM public.products p
     WHERE p.id IN (SELECT (e ->> 'product_id')::uuid FROM jsonb_array_elements(p_lines) e)
     ORDER BY p.id
       FOR NO KEY UPDATE;
  END IF;

  DROP TABLE IF EXISTS pg_temp._scl;
  CREATE TEMP TABLE _scl ON COMMIT DROP AS
    SELECT p.id AS product_id, p.name, p.sku, p.stock_quantity AS system_qty,
           (e ->> 'counted')::numeric::integer AS counted_qty,
           (e ->> 'counted')::numeric::integer - p.stock_quantity AS diff
    FROM jsonb_array_elements(p_lines) e
    JOIN public.products p ON p.id = (e ->> 'product_id')::uuid;

  SELECT count(*)::integer AS products,
         (count(*) FILTER (WHERE s.diff <> 0))::integer AS changed,
         coalesce(sum(s.system_qty), 0)::bigint AS units_before,
         coalesce(sum(s.counted_qty), 0)::bigint AS units_after,
         coalesce(sum(s.diff) FILTER (WHERE s.diff > 0), 0)::bigint AS up,
         coalesce(-sum(s.diff) FILTER (WHERE s.diff < 0), 0)::bigint AS down,
         (SELECT count(*) FROM public.products p
           WHERE p.is_active AND p.id NOT IN (SELECT s2.product_id FROM pg_temp._scl s2))::integer AS not_counted
    INTO v_sum
    FROM pg_temp._scl s;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'product_id', s.product_id, 'name', s.name, 'sku', s.sku,
           'system', s.system_qty, 'counted', s.counted_qty, 'diff', s.diff)
         ORDER BY abs(s.diff) DESC, s.name), '[]'::jsonb)
    INTO v_lines
    FROM pg_temp._scl s;

  SELECT a.value INTO v_set FROM public.app_settings a WHERE a.key = 'stock_mex_movements';
  v_from := public.stock_ts(v_set ->> 'from');

  IF coalesce(p_dry, false) THEN
    RETURN jsonb_build_object(
      'ok', true, 'dry', true, 'products', v_sum.products, 'changed', v_sum.changed,
      'units_before', v_sum.units_before, 'units_after', v_sum.units_after,
      'up', v_sum.up, 'down', v_sum.down, 'not_counted', v_sum.not_counted,
      'anchors', v_from IS NULL, 'from', v_from, 'lines', v_lines);
  END IF;

  INSERT INTO public.stock_counts
    (counted_at, counted_by, counted_by_name, note, products, changed, units_before, units_after)
  VALUES (v_now, p_actor, nullif(btrim(coalesce(p_actor_name, '')), ''), v_note,
          v_sum.products, v_sum.changed, v_sum.units_before, v_sum.units_after)
  RETURNING id INTO v_count;

  INSERT INTO public.stock_count_lines (count_id, product_id, system_qty, counted_qty, diff)
  SELECT v_count, s.product_id, s.system_qty, s.counted_qty, s.diff
  FROM pg_temp._scl s
  ORDER BY s.product_id;

  INSERT INTO public.inventory_logs
    (product_id, change_amount, previous_stock, new_stock, reason, movement_type, user_id, notes,
     stock_count_id, created_at)
  SELECT s.product_id, s.diff, s.system_qty, s.counted_qty, 'stock_count', 'count', p_actor,
         coalesce(v_note, ''), v_count, v_now
  FROM pg_temp._scl s
  WHERE s.diff <> 0
  ORDER BY s.product_id;

  UPDATE public.products p
     SET stock_quantity = s.counted_qty
    FROM pg_temp._scl s
   WHERE p.id = s.product_id AND s.diff <> 0;

  -- the trust anchor, and — the first time — where the MEX ledger starts
  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES ('stock_counted_at', to_jsonb(v_now), p_actor)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  IF v_from IS NULL THEN
    v_anchor := true;
    v_from := v_now;
    INSERT INTO public.app_settings (key, value, updated_by)
    VALUES ('stock_mex_movements',
            coalesce(v_set, '{"enabled": false, "free_units": "deduct"}'::jsonb)
              || jsonb_build_object('from', v_now, 'from_count_id', v_count),
            p_actor)
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;
    UPDATE public.stock_counts SET anchored = true WHERE id = v_count;
  END IF;

  RETURN jsonb_build_object(
    'ok', true, 'dry', false, 'count_id', v_count, 'counted_at', v_now,
    'products', v_sum.products, 'changed', v_sum.changed,
    'units_before', v_sum.units_before, 'units_after', v_sum.units_after,
    'up', v_sum.up, 'down', v_sum.down, 'not_counted', v_sum.not_counted,
    'anchored', v_anchor, 'from', v_from, 'lines', v_lines);
END;
$fn$;

COMMENT ON FUNCTION public.stock_count_apply(jsonb, uuid, text, text, boolean) IS
  'Saves one physical stock count (попис) — or, p_dry, previews it: sets on-hand to the counted quantity, one stock_counts row + lines, a ''count'' inventory_logs movement per non-zero difference, app_settings.stock_counted_at = now, and the first time stock_mex_movements.from = now. Never interleaves with stock_mex_apply(). The api calls it (owners / admin / warehouse) and writes the audit row. Migration 20260942000100.';

-- ── 8. The owner's switch ───────────────────────────────────────────────────
-- p_enabled on/off; p_free_units 'deduct' | 'skip' | NULL (unchanged).
-- Refuses to switch ON before a count ({ok: false, error: 'no_count'}).
-- Returns {ok, before, after}. The api gates it to business owners, audits
-- it and, when switched on, runs stock_mex_apply('switch_on') at once.
CREATE OR REPLACE FUNCTION public.stock_mex_set(
  p_enabled    boolean,
  p_free_units text,
  p_actor      uuid,
  p_actor_name text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_before jsonb;
  v_after  jsonb;
BEGIN
  IF p_enabled IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'enabled_required');
  END IF;
  IF p_free_units IS NOT NULL AND p_free_units NOT IN ('deduct', 'skip') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_free_units');
  END IF;
  SELECT a.value INTO v_before FROM public.app_settings a WHERE a.key = 'stock_mex_movements' FOR UPDATE;
  IF v_before IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_installed');
  END IF;
  IF p_enabled AND public.stock_ts(v_before ->> 'from') IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_count');
  END IF;

  v_after := v_before
          || jsonb_build_object('enabled', p_enabled,
                                'free_units', coalesce(p_free_units, v_before ->> 'free_units', 'deduct'),
                                'changed_at', now(), 'changed_by', p_actor,
                                'changed_by_name', nullif(btrim(coalesce(p_actor_name, '')), ''));
  IF p_enabled AND coalesce(v_before ->> 'enabled', 'false') <> 'true' THEN
    v_after := v_after || jsonb_build_object('enabled_at', now());
  END IF;

  UPDATE public.app_settings SET value = v_after, updated_by = p_actor WHERE key = 'stock_mex_movements';
  RETURN jsonb_build_object('ok', true, 'before', v_before, 'after', v_after);
END;
$fn$;

COMMENT ON FUNCTION public.stock_mex_set(boolean, text, uuid, text) IS
  'The owner''s switch for MEX-driven stock (app_settings.stock_mex_movements.enabled / free_units). Refuses ON before the first count. The api: owners only, audited, runs stock_mex_apply(''switch_on'') after switching on. Migration 20260942000100.';

-- ── 9. The stock health card ────────────────────────────────────────────────
-- { trusted, counted:{at, by, count_id, products, changed, anchored} | null,
--   catalogue:{active, counted, never_counted},
--   mex:{enabled, from, free_units, enabled_at, changed_by_name},
--   last_run:{at, status, error, movements, duration_ms} | null, last_ok_run,
--   applied:{movements, units_out, units_in, units_reversed, parcels_deducted, last_movement} (since from),
--   review:{parcels, deduct_events, skipped:{no_owner, no_lines, unmapped, test_phone},
--           unmapped:{lines, units, rows:[{name, src, why, lines, units}]},
--           not_stock:[{kind, lines, units}]} | null (no count yet),
--   pending:{keys, parcels, units_out, units_in, units_reversed, frozen} | null,
--   products:[{product_id, last_counted_at, counted_qty, out_30d, window_days, days_cover}] (p_detail) }
-- No money anywhere (the api gives it to owners, admin, managers, warehouse).
CREATE OR REPLACE FUNCTION public.stock_health(p_detail boolean DEFAULT true)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_set      jsonb;
  v_enabled  boolean;
  v_from     timestamptz;
  v_free     boolean;
  v_counted  timestamptz;
  v_last_ok  timestamptz;
  v_trusted  boolean;
  v_since    timestamptz;
  v_out      jsonb;
  v_review   jsonb;
  v_pending  jsonb;
  v_products jsonb := '[]'::jsonb;
BEGIN
  SELECT a.value INTO v_set FROM public.app_settings a WHERE a.key = 'stock_mex_movements';
  v_enabled := coalesce(v_set ->> 'enabled', 'false') = 'true';
  v_from    := public.stock_ts(v_set ->> 'from');
  v_free    := coalesce(v_set ->> 'free_units', 'deduct') <> 'skip';
  SELECT public.stock_ts(a.value #>> '{}') INTO v_counted FROM public.app_settings a WHERE a.key = 'stock_counted_at';
  SELECT max(r.finished_at) INTO v_last_ok FROM public.stock_mex_runs r WHERE r.status = 'ok';
  v_trusted := v_counted IS NOT NULL AND v_enabled AND v_last_ok >= now() - interval '3 hours';

  IF v_from IS NOT NULL THEN
    WITH d AS MATERIALIZED (SELECT * FROM public.stock_mex_desired(v_from, v_free)),
    pe AS (                -- per deduct event × owner: what it carries
      SELECT d.tracking_id, d.owner_kind, d.owner_ref,
             bool_or(d.line_state = 'no_owner') AS no_owner, bool_or(d.line_state = 'test_phone') AS test,
             count(*) FILTER (WHERE d.line_state = 'stock') AS n_stock,
             count(*) FILTER (WHERE d.line_state = 'unmapped') AS n_unm
      FROM d WHERE d.kind = 'deduct'
      GROUP BY 1, 2, 3
    ),
    pp AS (                -- per parcel: skipped when nothing of it is stock
      SELECT pe.tracking_id,
             CASE WHEN bool_or(pe.test) THEN 'test_phone'
                  WHEN bool_or(pe.no_owner) THEN 'no_owner'
                  WHEN sum(pe.n_stock) > 0 THEN NULL
                  WHEN sum(pe.n_unm) > 0 THEN 'unmapped'
                  ELSE 'no_lines' END AS skip
      FROM pe GROUP BY pe.tracking_id
    ),
    um AS (
      SELECT d.line_name, d.src, d.line_kind, count(*) AS lines, sum(d.qty) AS units
      FROM d WHERE d.line_state = 'unmapped'
      GROUP BY 1, 2, 3
    ),
    ns AS (
      SELECT d.line_kind, count(*) AS lines, coalesce(sum(d.qty), 0) AS units
      FROM d WHERE d.line_state = 'not_stock'
      GROUP BY 1
    )
    SELECT jsonb_build_object(
      'parcels', (SELECT count(DISTINCT d.tracking_id) FROM d),
      'deduct_events', (SELECT count(*) FROM pp),
      'skipped', jsonb_build_object(
        'no_owner',   (SELECT count(*) FROM pp WHERE pp.skip = 'no_owner'),
        'no_lines',   (SELECT count(*) FROM pp WHERE pp.skip = 'no_lines'),
        'unmapped',   (SELECT count(*) FROM pp WHERE pp.skip = 'unmapped'),
        'test_phone', (SELECT count(*) FROM pp WHERE pp.skip = 'test_phone')),
      'unmapped', jsonb_build_object(
        'lines', (SELECT coalesce(sum(um.lines), 0) FROM um),
        'units', (SELECT coalesce(sum(um.units), 0) FROM um),
        'names', (SELECT count(*) FROM um),
        'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.line_name, 'src', x.src, 'why', x.line_kind,
                                                              'lines', x.lines, 'units', x.units)
                                           ORDER BY x.units DESC, x.line_name)
                            FROM (SELECT * FROM um ORDER BY um.units DESC, um.line_name LIMIT 30) x), '[]'::jsonb)),
      'not_stock', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', ns.line_kind, 'lines', ns.lines, 'units', ns.units)
                                              ORDER BY ns.units DESC) FROM ns), '[]'::jsonb))
      INTO v_review;

    SELECT jsonb_build_object(
             'keys', count(DISTINCT (p.tracking_id, p.owner_kind, p.owner_ref, p.kind)) FILTER (WHERE NOT p.frozen),
             'parcels', count(DISTINCT p.tracking_id) FILTER (WHERE NOT p.frozen),
             'units_out', coalesce(sum(p.delta) FILTER (WHERE NOT p.frozen AND p.kind = 'deduct' AND p.delta > 0), 0),
             'units_in', coalesce(sum(p.delta) FILTER (WHERE NOT p.frozen AND p.kind = 'restock' AND p.delta > 0), 0),
             'units_reversed', coalesce(-sum(p.delta) FILTER (WHERE NOT p.frozen AND p.delta < 0), 0),
             'frozen', count(*) FILTER (WHERE p.frozen))
      INTO v_pending
      FROM public.stock_mex_pending(v_from, v_free) p;
  END IF;

  IF coalesce(p_detail, true) THEN
    v_since := greatest(now() - interval '30 days', coalesce(v_from, now()));
    WITH lc AS (
      SELECT DISTINCT ON (l.product_id) l.product_id, c.counted_at, l.counted_qty
      FROM public.stock_count_lines l JOIN public.stock_counts c ON c.id = l.count_id
      ORDER BY l.product_id, c.counted_at DESC
    ),
    o30 AS (               -- units the MEX ledger holds as deducted, events in the last 30 days (since from)
      SELECT l.product_id, sum(l.qty_applied) AS u
      FROM public.stock_mex_ledger h
      JOIN public.stock_mex_ledger_lines l ON l.ledger_id = h.id
      WHERE h.kind = 'deduct' AND h.event_at >= v_since
      GROUP BY l.product_id
    )
    SELECT coalesce(jsonb_agg(jsonb_build_object(
             'product_id', p.id,
             'last_counted_at', lc.counted_at,
             'counted_qty', lc.counted_qty,
             'out_30d', CASE WHEN v_from IS NOT NULL THEN coalesce(o30.u, 0) END,
             'window_days', CASE WHEN v_from IS NOT NULL THEN round(extract(epoch FROM now() - v_since) / 86400.0, 1) END,
             'days_cover', CASE WHEN v_trusted AND coalesce(o30.u, 0) > 0
                                THEN round(p.stock_quantity / (o30.u / greatest(extract(epoch FROM now() - v_since) / 86400.0, 1)), 1) END)
             ORDER BY p.name), '[]'::jsonb)
      INTO v_products
      FROM public.products p
      LEFT JOIN lc ON lc.product_id = p.id
      LEFT JOIN o30 ON o30.product_id = p.id
     WHERE p.is_active OR lc.product_id IS NOT NULL OR o30.product_id IS NOT NULL;
  END IF;

  SELECT jsonb_build_object(
    'trusted', v_trusted,
    'counted', (SELECT jsonb_build_object('at', c.counted_at, 'by', c.counted_by_name, 'count_id', c.id,
                                          'products', c.products, 'changed', c.changed, 'anchored', c.anchored)
                  FROM public.stock_counts c ORDER BY c.counted_at DESC LIMIT 1),
    'counted_at', v_counted,
    'catalogue', jsonb_build_object(
      'active', (SELECT count(*) FROM public.products p WHERE p.is_active),
      'counted', (SELECT count(*) FROM public.products p WHERE p.is_active
                     AND EXISTS (SELECT 1 FROM public.stock_count_lines l WHERE l.product_id = p.id)),
      'never_counted', (SELECT count(*) FROM public.products p WHERE p.is_active
                           AND NOT EXISTS (SELECT 1 FROM public.stock_count_lines l WHERE l.product_id = p.id))),
    'mex', jsonb_build_object('enabled', v_enabled, 'from', v_from,
                              'free_units', coalesce(v_set ->> 'free_units', 'deduct'),
                              'enabled_at', public.stock_ts(v_set ->> 'enabled_at'),
                              'changed_by_name', v_set ->> 'changed_by_name'),
    'last_run', (SELECT jsonb_build_object('at', r.started_at, 'status', r.status, 'error', r.error,
                                           'movements', r.movements, 'duration_ms', r.duration_ms)
                   FROM public.stock_mex_runs r ORDER BY r.started_at DESC LIMIT 1),
    'last_ok_run', v_last_ok,
    'applied', CASE WHEN v_from IS NOT NULL THEN (
      SELECT jsonb_build_object(
               'movements', count(*),
               'units_out', coalesce(-sum(l.change_amount) FILTER (WHERE l.movement_type = 'mex_deduct'), 0),
               'units_in', coalesce(sum(l.change_amount) FILTER (WHERE l.movement_type = 'mex_restock'), 0),
               'units_reversed', coalesce(sum(abs(l.change_amount)) FILTER (WHERE l.movement_type = 'mex_reverse'), 0),
               'last_movement', max(l.created_at),
               'parcels_deducted', (SELECT count(DISTINCT h.tracking_id) FROM public.stock_mex_ledger h
                                     WHERE h.kind = 'deduct' AND h.units_applied > 0))
        FROM public.inventory_logs l
       WHERE l.stock_ledger_id IS NOT NULL AND l.created_at >= v_from) END,
    'review', v_review,
    'pending', v_pending,
    'products', v_products)
    INTO v_out;
  RETURN v_out;
END;
$fn$;

COMMENT ON FUNCTION public.stock_health(boolean) IS
  'Warehouse → Попис stock health card: the last count, the MEX switch, the last run, what the ledger applied since `from`, what waits for review (unmapped lines, skipped parcels) and what a run would move now; per product the last count and days of cover (only when trusted). No money. Migration 20260942000100.';

-- ── 10. Atomic restock (POST /api/restock used to read, add and write back —
-- a lost update against a concurrent ledger run) ───────────────────────────
CREATE OR REPLACE FUNCTION public.stock_restock(
  p_product        uuid,
  p_quantity       integer,
  p_actor          uuid,
  p_supplier_name  text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_notes          text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_new  integer;
  v_name text;
BEGIN
  IF p_product IS NULL OR p_quantity IS NULL OR p_quantity < 1 OR p_quantity > 1000000 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_quantity');
  END IF;
  UPDATE public.products p
     SET stock_quantity = p.stock_quantity + p_quantity
   WHERE p.id = p_product
  RETURNING p.stock_quantity, p.name INTO v_new, v_name;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found');
  END IF;
  INSERT INTO public.inventory_logs
    (product_id, change_amount, previous_stock, new_stock, reason, movement_type, user_id,
     supplier_name, invoice_number, notes)
  VALUES (p_product, p_quantity, v_new - p_quantity, v_new, 'restock', 'restock', p_actor,
          coalesce(p_supplier_name, ''), coalesce(p_invoice_number, ''), coalesce(p_notes, ''));
  RETURN jsonb_build_object('ok', true, 'product_name', v_name, 'new_stock', v_new);
END;
$fn$;

COMMENT ON FUNCTION public.stock_restock(uuid, integer, uuid, text, text, text) IS
  'POST /api/restock: adds units in ONE statement (no read-modify-write) and logs the movement with the exact before/after. Migration 20260942000100.';


-- ── 11. insights_stock — redefined from 20260941000500, the trust verdict only ─
-- Copied verbatim except: (a)/(c) a count's movements ('count' / 'stock_count')
-- are counts; (b) a product a stock count covered is tracked and never the
-- placeholder; (d) trusted = a count exists (app_settings.stock_counted_at)
-- AND stock_mex_movements.enabled AND an ok stock_mex_apply() run in the last
-- 3 hours — no longer "the last deduction is within 3 days of the last
-- parcel" (a single hand-shipped order satisfied that); (e) trust gains
-- counted / mex_enabled / mex_from / mex_last_run. Everything that hangs on
-- trusted (out / low, days of cover, the valuation) is unchanged.
CREATE OR REPLACE FUNCTION public.insights_stock(
  p_from        timestamptz,
  p_to_end      timestamptz,
  p_prev_from   timestamptz DEFAULT NULL,
  p_prev_to_end timestamptz DEFAULT NULL,
  p_sources     text[]      DEFAULT NULL,
  p_money       boolean     DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET TimeZone = 'UTC'
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_all  text[] := ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'];
  v_src  text[];
  v_bad  text;
  v_pf   timestamptz;
  v_pt   timestamptz;
  v_fd   date;
  v_td   date;
  v_gran text;
  v_lo   timestamptz;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_stock: bad window' USING ERRCODE = '22023';
  END IF;
  IF p_prev_from IS NOT NULL AND p_prev_to_end IS NOT NULL AND p_prev_to_end >= p_prev_from
     AND p_prev_to_end < p_from AND p_to_end - p_from <= interval '93 days' THEN
    v_pf := p_prev_from;
    v_pt := p_prev_to_end;
  END IF;

  SELECT array_agg(DISTINCT lower(btrim(s))) INTO v_src
    FROM unnest(coalesce(p_sources, ARRAY[]::text[])) s
   WHERE nullif(btrim(s), '') IS NOT NULL;
  IF v_src IS NULL OR cardinality(v_src) = 0 THEN
    v_src := v_all;
  END IF;
  SELECT s INTO v_bad FROM unnest(v_src) s WHERE NOT (s = ANY (v_all)) LIMIT 1;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'insights_stock: unknown source %', v_bad USING ERRCODE = '22023';
  END IF;

  v_fd   := (p_from   AT TIME ZONE 'Europe/Skopje')::date;
  v_td   := (p_to_end AT TIME ZONE 'Europe/Skopje')::date;
  v_gran := CASE WHEN v_td - v_fd + 1 <= 62 THEN 'day' ELSE 'month' END;
  v_lo   := least(p_from, coalesce(v_pf, p_from));

  -- $1 from · $2 to_end · $3 prev_from · $4 prev_to_end · $5 sources ·
  -- $6 earliest instant (prev) · $7 from day · $8 to day · $9 trend
  -- granularity · $10 the test phones' last-8 digits · $11 today (Skopje)
  EXECUTE $st$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::timestamptz AS pf, $4::timestamptz AS pt,
         $5::text[] AS srcs, $7::date AS fd, $8::date AS td, $9::text AS gran, $11::date AS today,
         CASE WHEN $9::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- ── what moved: the cohort's sales (sale day), what came back (MEX return
-- day) and what waits in the warehouse NOW ─────────────────────────────────
sr AS MATERIALIZED (       -- the period's sales (+ the previous period's, for the movers)
  SELECT r.kind, r.source, r.sale_source, r.order_id, r.web_id,
         (r.sale_at BETWEEN $1 AND $2) AS cur,
         coalesce(r.sale_at BETWEEN $3 AND $4, false) AS prev,
         to_char(date_trunc($9, (r.sale_at AT TIME ZONE 'Europe/Skopje')::date::timestamp),
                 CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
  FROM public.insights_sale_rows($6, $2, false) r
  WHERE r.in_total AND r.source = ANY ($5)
),
rt AS MATERIALIZED (       -- parcels MEX returned in the period (goods back on the shelf)
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id
  FROM public.insights_parcel_rows($1, $2, 'returned') q
  WHERE q.source = ANY ($5)
),
lb AS MATERIALIZED (       -- label printed, waiting for the courier NOW (MEX 8) — each parcel once
  SELECT q.kind, q.source, q.sale_source, q.order_id, q.web_id, q.sale_at, q.cod_mkd AS value_mkd
  FROM public.insights_parcel_rows($1, $2, 'label_now') q
  WHERE q.source = ANY ($5) AND coalesce(q.cod_mkd, 0) > 0
),
wc AS MATERIALIZED (       -- parcels a live web order claims (web claims win — the cohort's rule)
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
tp AS MATERIALIZED (       -- the test phones' parcels
  SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY ($10)
),
tk AS MATERIALIZED (       -- to pack NOW: sold, no parcel yet (the cohort's to_pack bucket)
  SELECT 'order'::text AS kind, public.cohort_order_source(x.sale_source) AS source, x.sale_source,
         x.id AS order_id, NULL::integer AS web_id,
         coalesce(x.sold_at,
                  (SELECT max(l.decided_at) FROM public.altercpa_leads l
                    WHERE x.sold_at IS NULL AND l.order_id = x.id
                      AND l.decision IN ('approved', 'cancel_other') AND l.decided_at IS NOT NULL),
                  x.confirmed_at, x.created_at) AS sale_at,
         round(coalesce(x.price, 0) * 61.5) AS value_mkd
  FROM public.orders x
  WHERE x.status = 'confirmed'
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type,
                                   x.sale_source_detail, x.mex_tracking_id, x.mex_status_id,
                                   x.mex_cod_mkd, x.mex_delivered_at,
                                   coalesce(x.mex_tracking_id IN (SELECT wc.tr FROM wc), false)) = 'to_pack'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), $10)
    AND NOT coalesce(x.mex_tracking_id IN (SELECT tp.tr FROM tp), false)
    AND public.cohort_order_source(x.sale_source) = ANY ($5)
  UNION ALL
  SELECT 'web', 'web', NULL, NULL, w.shop_order_id, w.created_at, round(w.total)
  FROM public.web_orders w
  WHERE w.deleted_in_shop_at IS NULL
    AND w.mex_tracking_id IS NULL
    AND coalesce(w.total, 0) > 0
    AND w.created_at > $11::timestamp - interval '400 days'
    AND public.web_order_outcome(w.status, w.payment_status, w.payment_method) = 'preparing'
    AND NOT public.insights_excluded8(w.phone8, $10)
    AND 'web' = ANY ($5)
),
qu AS (                    -- the queue: to pack + label printed, with the age of the sale
  SELECT x.*, ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) AS age,
         CASE WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 2 THEN '0_2'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 7 THEN '3_7'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 14 THEN '8_14'
              WHEN ($11::date - (x.sale_at AT TIME ZONE 'Europe/Skopje')::date) <= 30 THEN '15_30'
              ELSE '31_plus' END AS age_key
  FROM (SELECT tk.*, 'to_pack'::text AS stage FROM tk
        UNION ALL
        SELECT lb.kind, lb.source, lb.sale_source, lb.order_id, lb.web_id, lb.sale_at, lb.value_mkd, 'label' FROM lb) x
),
-- ── every item line, once per (lset, flags) ─────────────────────────────────
-- lset: sold (cur / prev, day, source) · returned · to_pack · label. A line is
-- keyed by its text (src, product id, name, web kind, free, impossible qty).
ln AS MATERIALIZED (
  SELECT u.lset, u.cur, u.prev, u.d, u.source,
         CASE WHEN u.kind = 'web' THEN 'web' WHEN u.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         i.product_id AS pid, i.product_name AS nm, NULL::text AS wk,
         (coalesce(i.price_per_unit, 0) <= 0) AS free, (coalesce(i.quantity, 0) >= 100) AS bad,
         coalesce(i.quantity, 0) AS q
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.kind, sr.sale_source, sr.order_id FROM sr WHERE sr.kind = 'order'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.kind, rt.sale_source, rt.order_id FROM rt WHERE rt.kind = 'order'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.kind, qu.sale_source, qu.order_id FROM qu WHERE qu.kind = 'order') u
  -- a HASH join on purpose (all of a year's lines; see insights_returns)
  JOIN public.order_items i ON (i.order_id::text) = u.order_id::text
  UNION ALL
  SELECT u.lset, u.cur, u.prev, u.d, u.source, 'web', NULL::uuid, i.name, i.kind,
         (coalesce(i.price, 0) <= 0), (coalesce(i.quantity, 0) >= 100), coalesce(i.quantity, 0)
  FROM (SELECT 'sold'::text AS lset, sr.cur, sr.prev, sr.d, sr.source, sr.web_id FROM sr WHERE sr.kind = 'web'
        UNION ALL SELECT 'returned', false, false, NULL, rt.source, rt.web_id FROM rt WHERE rt.kind = 'web'
        UNION ALL SELECT qu.stage, false, false, NULL, qu.source, qu.web_id FROM qu WHERE qu.kind = 'web') u
  JOIN public.web_order_items i ON i.shop_order_id = u.web_id
),
la AS MATERIALIZED (       -- folded per distinct line text (a few thousand)
  SELECT ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur), 0)                              AS q_cur,
         count(*) FILTER (WHERE ln.lset = 'sold' AND ln.cur)                                            AS n_cur,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.prev), 0)                             AS q_prev,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'altercpa'), 0)   AS q_alt,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'elyon_crm'), 0)  AS q_ely,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'web'), 0)        AS q_web,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'sold' AND ln.cur AND ln.source = 'teleshop_other'), 0) AS q_tel,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'returned'), 0)                                     AS q_ret,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'to_pack'), 0)                                      AS q_pack,
         coalesce(sum(ln.q) FILTER (WHERE ln.lset = 'label'), 0)                                        AS q_label
  FROM ln
  GROUP BY ln.src, ln.nm, ln.pid, ln.wk, ln.free, ln.bad
),
cat AS MATERIALIZED (      -- active catalogue names: an unaliased line equal to ONE of them folds into it
  SELECT public.product_alias_norm(p.name) AS norm, min(p.id::text) AS id, count(*) AS n
  FROM public.products p WHERE p.is_active GROUP BY 1
),
lk AS MATERIALIZED (       -- each line text: its product key and kind, computed ONCE
  SELECT x.*,
         CASE WHEN c.id IS NOT NULL THEN 'p:' || c.id ELSE x.k END AS key,
         CASE WHEN x.ak <> 'product'                                     THEN x.ak
              WHEN lower(x.nm) ~ '^\s*(поен|poen)'                        THEN 'loyalty_point'
              WHEN lower(x.nm) ~ '(забелешка|zabeleska|zabeleshka)'       THEN 'note'
              WHEN lower(x.nm) ~ '^\s*(флаер|flaer|flyer)'                THEN 'flyer'
              WHEN lower(x.nm) ~ '^\s*(достава|dostava)'                  THEN 'delivery'
              WHEN x.bad                                                  THEN 'bad_quantity'
              WHEN x.wk = 'GIFT' OR x.free                                THEN 'gift'
              ELSE 'product' END AS lkind
  FROM (SELECT la.*, public.product_key(la.src, la.nm, la.pid) AS k, public.order_line_kind(la.src, la.nm) AS ak
          FROM la) x
  LEFT JOIN cat c ON c.n = 1 AND x.k LIKE 'n:%' AND c.norm = substr(x.k, 3)
),
-- a line's kind by its text key, as ONE jsonb object (a lookup, not a join)
lmap AS MATERIALIZED (
  SELECT coalesce(jsonb_object_agg(lk.lkey, lk.lkind), '{}'::jsonb) AS m FROM lk
),
pg AS MATERIALIZED (       -- per product key: products and gifts (the rest is not a product)
  SELECT lk.key,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'product'), 0)   AS units,
         coalesce(sum(lk.q_prev) FILTER (WHERE lk.lkind = 'product'), 0)  AS units_prev,
         coalesce(sum(lk.q_alt) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_alt,
         coalesce(sum(lk.q_ely) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_ely,
         coalesce(sum(lk.q_web) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_web,
         coalesce(sum(lk.q_tel) FILTER (WHERE lk.lkind = 'product'), 0)   AS u_tel,
         coalesce(sum(lk.q_cur) FILTER (WHERE lk.lkind = 'gift'), 0)      AS free_units,
         coalesce(sum(lk.q_ret) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)   AS returned_units,
         coalesce(sum(lk.q_pack) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0)  AS pack_units,
         coalesce(sum(lk.q_label) FILTER (WHERE lk.lkind IN ('product', 'gift')), 0) AS label_units,
         (array_agg(lk.nm ORDER BY lk.q_cur DESC NULLS LAST, lk.nm))[1]   AS sample
  FROM lk
  WHERE lk.key IS NOT NULL AND lk.lkind IN ('product', 'gift')
  GROUP BY lk.key
),
-- ── the catalogue and its ledger ───────────────────────────────────────────
lgp AS (
  SELECT l.product_id, count(*) AS n_logs,
         count(*) FILTER (WHERE l.movement_type = 'manual_adjust' OR l.reason = 'manual') AS n_adjust,
         max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS counted_at,
         max(l.created_at) AS moved_at
  FROM public.inventory_logs l
  GROUP BY l.product_id
),
scl AS (                  -- products a stock count (попис) covered (20260942000100)
  SELECT l.product_id, max(c.counted_at) AS counted_at
  FROM public.stock_count_lines l
  JOIN public.stock_counts c ON c.id = l.count_id
  GROUP BY l.product_id
),
pc AS MATERIALIZED (
  SELECT p.id, p.name, p.sku, p.is_active, p.stock_quantity, p.low_stock_threshold, p.cost_price, p.price,
         (coalesce(g.n_logs, 0) > 0 OR coalesce(p.stock_quantity, 0) <> 0 OR s.product_id IS NOT NULL) AS tracked,
         (p.stock_quantity = 1000 AND g.n_logs = g.n_adjust AND g.n_adjust > 0 AND s.product_id IS NULL) AS placeholder,
         (coalesce(p.cost_price, 0) > 0) AS cost_known,
         greatest(g.counted_at, s.counted_at) AS counted_at, g.moved_at,
         -- a duplicate candidate key: the first word, transliterated (Adenofrin · ADENOFRIN 20/1 cps)
         CASE WHEN length(public.mk_geo_norm(split_part(btrim(p.name), ' ', 1))) >= 4
              THEN public.mk_geo_norm(split_part(btrim(p.name), ' ', 1)) END AS dup_key
  FROM public.products p
  LEFT JOIN lgp g ON g.product_id = p.id
  LEFT JOIN scl s ON s.product_id = p.id
),
lg AS (
  SELECT max(l.created_at) FILTER (WHERE l.movement_type IN ('manual_adjust', 'bigarena_sync', 'count') OR l.reason IN ('manual', 'bigarena_import', 'stock_count')) AS last_count_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'restock' OR l.reason = 'restock')                                               AS last_restock_at,
         max(l.created_at) FILTER (WHERE l.movement_type = 'order_deduction' OR l.reason = 'order_deduction')                               AS last_deduction_at,
         max(l.created_at)                                                                                                                  AS last_move_at,
         coalesce(-sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount < 0), 0) AS out_window,
         coalesce(sum(l.change_amount) FILTER (WHERE l.created_at BETWEEN $1 AND $2 AND l.change_amount > 0), 0)  AS in_window,
         count(*) FILTER (WHERE l.created_at BETWEEN $1 AND $2)                                                  AS moves_window
  FROM public.inventory_logs l
),
ps AS (                    -- MEX parcels created: in the period, and since the ledger's last deduction
  SELECT count(*) FILTER (WHERE p.created_at_mex BETWEEN $1 AND $2)                      AS in_window,
         count(*) FILTER (WHERE p.created_at_mex > coalesce(lg.last_deduction_at, '-infinity')) AS since_deduction,
         max(p.created_at_mex)                                                           AS last_parcel_at
  FROM lg
  JOIN public.mex_parcels p ON p.created_at_mex >= least($1, coalesce(lg.last_deduction_at, $1))
  WHERE NOT public.insights_excluded8(p.phone8, $10)
),
st AS (                    -- the stock regime (20260942000100): a count, and the MEX ledger on and running
  SELECT public.stock_ts((SELECT a.value #>> '{}' FROM public.app_settings a WHERE a.key = 'stock_counted_at')) AS counted_at,
         coalesce((SELECT a.value ->> 'enabled' FROM public.app_settings a WHERE a.key = 'stock_mex_movements'), 'false') = 'true' AS mex_enabled,
         public.stock_ts((SELECT a.value ->> 'from' FROM public.app_settings a WHERE a.key = 'stock_mex_movements')) AS mex_from,
         (SELECT max(r.finished_at) FROM public.stock_mex_runs r WHERE r.status = 'ok') AS mex_last_run
),
tr AS (                    -- is the stock count worth reading? counted, and the MEX ledger follows every parcel since
  SELECT (st.counted_at IS NOT NULL AND st.mex_enabled
          AND coalesce(st.mex_last_run >= now() - interval '3 hours', false)) AS trusted,
         lg.*, ps.in_window AS parcels_window, ps.since_deduction, ps.last_parcel_at,
         st.counted_at, st.mex_enabled, st.mex_from, st.mex_last_run
  FROM lg, ps, st
),
-- ── the product table ──────────────────────────────────────────────────────
pr0 AS (
  SELECT coalesce(g.key, 'p:' || c.id::text) AS key, c.id AS product_id,
         coalesce(c.name, g.sample) AS name, c.sku, c.is_active, (c.id IS NOT NULL) AS catalogue,
         coalesce(c.tracked, false) AS tracked, coalesce(c.placeholder, false) AS placeholder,
         CASE WHEN c.tracked THEN c.stock_quantity END AS on_hand,
         c.low_stock_threshold, c.cost_known, c.cost_price, c.price, c.counted_at,
         coalesce(g.units, 0) AS units, coalesce(g.units_prev, 0) AS units_prev,
         coalesce(g.u_alt, 0) AS u_alt, coalesce(g.u_ely, 0) AS u_ely, coalesce(g.u_web, 0) AS u_web, coalesce(g.u_tel, 0) AS u_tel,
         coalesce(g.free_units, 0) AS free_units, coalesce(g.returned_units, 0) AS returned_units,
         coalesce(g.pack_units, 0) AS pack_units, coalesce(g.label_units, 0) AS label_units
  FROM pg g
  -- every active catalogue product, plus any inactive one that still sold
  FULL JOIN (SELECT * FROM pc
              WHERE pc.is_active OR 'p:' || pc.id::text IN (SELECT pg.key FROM pg WHERE pg.key LIKE 'p:%')) c
         ON g.key = 'p:' || c.id::text
),
pr1 AS (
  SELECT pr0.*,
         CASE WHEN NOT pr0.catalogue THEN NULL
              WHEN NOT pr0.tracked THEN 'not_tracked'
              WHEN pr0.on_hand <= 0 THEN 'out'
              WHEN pr0.on_hand < coalesce(pr0.low_stock_threshold, 0) THEN 'low'
              ELSE 'ok' END AS state,
         row_number() OVER (ORDER BY pr0.units DESC, pr0.pack_units + pr0.label_units DESC, pr0.name) AS rn
  FROM pr0
),
prj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'key', p.key, 'product_id', p.product_id, 'name', p.name, 'sku', p.sku,
           'catalogue', p.catalogue, 'tracked', p.tracked, 'placeholder', p.placeholder, 'state', p.state,
           'on_hand', p.on_hand, 'low_threshold', p.low_stock_threshold, 'cost_known', p.cost_known,
           'units', p.units, 'units_prev', CASE WHEN tr0.pf IS NULL THEN NULL ELSE p.units_prev END,
           'by_source', jsonb_build_object('altercpa', p.u_alt, 'elyon_crm', p.u_ely, 'web', p.u_web, 'teleshop_other', p.u_tel),
           'free_units', p.free_units, 'returned_units', p.returned_units,
           'queue_units', p.pack_units + p.label_units, 'pack_units', p.pack_units, 'label_units', p.label_units,
           'days_cover', CASE WHEN tr0.trusted AND p.tracked AND p.units > 0 AND p.on_hand IS NOT NULL
                              THEN round(p.on_hand / (p.units::numeric / tr0.days), 1) END,
           'cost_mkd', CASE WHEN p.cost_known THEN round(p.cost_price * 61.5) END,
           'price_mkd', CASE WHEN p.price > 0 THEN round(p.price * 61.5) END,
           'stock_value_mkd', CASE WHEN tr0.trusted AND p.tracked AND p.cost_known AND p.on_hand > 0
                                   THEN round(p.on_hand * p.cost_price * 61.5) END)
         ORDER BY p.rn), '[]'::jsonb) AS j
  FROM pr1 p
  CROSS JOIN (SELECT tr.trusted, prm.pf, (prm.td - prm.fd + 1) AS days FROM tr, prm) tr0
  -- every catalogue product, and the rest (names not in the catalogue) up to 120 rows
  WHERE p.catalogue OR p.rn <= 120
),
prx AS (                   -- what the 120-row cut left out
  SELECT count(*) AS products, coalesce(sum(p.units), 0) AS units
  FROM pr1 p WHERE NOT p.catalogue AND p.rn > 120
),
-- ── KPIs ───────────────────────────────────────────────────────────────────
kp AS (
  SELECT (SELECT count(*) FROM sr WHERE sr.cur)                          AS sales,
         (SELECT count(*) FROM sr WHERE sr.cur AND sr.kind = 'mex')      AS sales_mex_only,
         (SELECT count(*) FROM sr WHERE sr.prev)                         AS sales_prev,
         (SELECT coalesce(sum(g.units), 0) FROM pg g)                    AS units,
         (SELECT coalesce(sum(g.units_prev), 0) FROM pg g)               AS units_prev,
         (SELECT coalesce(sum(g.free_units), 0) FROM pg g)               AS free_units,
         (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'p:%') AS units_catalogue,
         (SELECT count(*) FROM pg g WHERE g.units > 0)                   AS products_sold,
         (SELECT coalesce(sum(g.returned_units), 0) FROM pg g)           AS returned_units,
         (SELECT count(*) FROM rt)                                       AS returned_parcels,
         (SELECT count(*) FROM rt WHERE rt.kind = 'mex')                 AS returned_mex_only
),
-- ── the queue ──────────────────────────────────────────────────────────────
qa AS (
  SELECT qu.stage, qu.age_key, qu.source,
         count(*) AS n, coalesce(sum(qu.value_mkd), 0) AS v,
         count(*) FILTER (WHERE qu.kind = 'order') AS n_o, count(*) FILTER (WHERE qu.kind = 'web') AS n_w,
         count(*) FILTER (WHERE qu.kind = 'mex') AS n_m,
         min(qu.sale_at) AS oldest, max(qu.age) AS max_age, min(qu.age) AS min_age
  FROM qu
  GROUP BY GROUPING SETS ((qu.stage, qu.age_key), (qu.stage, qu.source), (qu.stage))
),
qj AS (
  SELECT jsonb_agg(jsonb_build_object(
           'stage', s.stage,
           'count', coalesce(t.n, 0), 'value_mkd', round(coalesce(t.v, 0)),
           'orders', coalesce(t.n_o, 0), 'web', coalesce(t.n_w, 0), 'mex_only', coalesce(t.n_m, 0),
           'oldest', to_char((t.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
           'units', (SELECT coalesce(sum(CASE WHEN s.stage = 'to_pack' THEN g.pack_units ELSE g.label_units END), 0) FROM pg g),
           'ages', (SELECT jsonb_agg(jsonb_build_object(
                             'key', a.key, 'count', coalesce(x.n, 0), 'value_mkd', round(coalesce(x.v, 0)),
                             'orders', coalesce(x.n_o, 0), 'web', coalesce(x.n_w, 0), 'mex_only', coalesce(x.n_m, 0),
                             -- the sale days this age covers (for the /orders drill)
                             'from', to_char(CASE WHEN a.hi IS NULL THEN ($11::date - coalesce(x.max_age, a.lo)) ELSE $11::date - a.hi END, 'YYYY-MM-DD'),
                             'to', to_char($11::date - a.lo, 'YYYY-MM-DD'))
                           ORDER BY a.ord)
                    FROM (VALUES ('0_2', 0, 2, 1), ('3_7', 3, 7, 2), ('8_14', 8, 14, 3), ('15_30', 15, 30, 4), ('31_plus', 31, NULL, 5)) a(key, lo, hi, ord)
                    LEFT JOIN qa x ON x.stage = s.stage AND x.age_key = a.key AND x.source IS NULL),
           'by_source', (SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.source, 'count', x.n, 'value_mkd', round(x.v),
                                                                    'orders', x.n_o, 'web', x.n_w, 'mex_only', x.n_m,
                                                                    'oldest', to_char((x.oldest AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'))
                                                   ORDER BY array_position(ARRAY['altercpa', 'elyon_crm', 'web', 'teleshop_other'], x.source)), '[]'::jsonb)
                         FROM qa x WHERE x.stage = s.stage AND x.source IS NOT NULL AND x.age_key IS NULL))
         ORDER BY s.ord) AS j
  FROM (VALUES ('to_pack', 1), ('label', 2)) s(stage, ord)
  LEFT JOIN qa t ON t.stage = s.stage AND t.age_key IS NULL AND t.source IS NULL
),
-- the products waiting in the queue (units)
qp AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('key', x.key, 'name', coalesce(c.name, x.sample), 'catalogue', c.id IS NOT NULL,
                                               'pack_units', x.pack_units, 'label_units', x.label_units,
                                               'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END)
                            ORDER BY x.pack_units + x.label_units DESC, x.key), '[]'::jsonb) AS j
  FROM (SELECT g.*, row_number() OVER (ORDER BY g.pack_units + g.label_units DESC, g.key) AS rn
          FROM pg g WHERE g.pack_units + g.label_units > 0) x
  LEFT JOIN pc c ON x.key = 'p:' || c.id::text
  WHERE x.rn <= 20
),
-- ── the trend: product units per day (per month beyond 62 days), by source ──
lt AS (
  SELECT ln.d, ln.source,
         concat_ws(chr(31), ln.src, coalesce(ln.pid::text, ''), coalesce(ln.nm, ''), coalesce(ln.wk, ''),
                   ln.free::int::text, ln.bad::int::text) AS lkey,
         sum(ln.q) AS q
  FROM ln WHERE ln.lset = 'sold' AND ln.cur
  GROUP BY 1, 2, 3
),
tv AS (
  SELECT lt.d,
         sum(lt.q) FILTER (WHERE lt.source = 'altercpa')       AS alt,
         sum(lt.q) FILTER (WHERE lt.source = 'elyon_crm')      AS ely,
         sum(lt.q) FILTER (WHERE lt.source = 'web')            AS web,
         sum(lt.q) FILTER (WHERE lt.source = 'teleshop_other') AS tel
  FROM lt
  WHERE (SELECT lmap.m FROM lmap) ->> lt.lkey = 'product'
  GROUP BY lt.d
),
tj AS (
  SELECT coalesce(jsonb_agg(jsonb_build_object('d', k.d,
           'units', coalesce(tv.alt, 0) + coalesce(tv.ely, 0) + coalesce(tv.web, 0) + coalesce(tv.tel, 0),
           'by_source', jsonb_build_object('altercpa', coalesce(tv.alt, 0), 'elyon_crm', coalesce(tv.ely, 0),
                                           'web', coalesce(tv.web, 0), 'teleshop_other', coalesce(tv.tel, 0)))
         ORDER BY k.d), '[]'::jsonb) AS j
  FROM (SELECT to_char(g, CASE WHEN $9 = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END) AS d
          FROM generate_series(date_trunc($9, $7::timestamp), date_trunc($9, $8::timestamp), ('1 ' || $9)::interval) g) k
  LEFT JOIN tv ON tv.d = k.d
),
-- ── catalogue hygiene ──────────────────────────────────────────────────────
hy AS (
  SELECT jsonb_build_object(
    'duplicates', coalesce((
      SELECT jsonb_agg(jsonb_build_object('key', d.dup_key, 'products', d.products) ORDER BY d.units DESC, d.dup_key)
      FROM (SELECT c.dup_key, sum(coalesce(g.units, 0)) AS units,
                   jsonb_agg(jsonb_build_object('product_id', c.id, 'name', c.name, 'tracked', c.tracked,
                                                'on_hand', CASE WHEN c.tracked THEN c.stock_quantity END,
                                                'units', coalesce(g.units, 0))
                             ORDER BY coalesce(g.units, 0) DESC, c.name) AS products
            FROM pc c LEFT JOIN pg g ON g.key = 'p:' || c.id::text
            WHERE c.is_active AND c.dup_key IS NOT NULL
            GROUP BY c.dup_key HAVING count(*) > 1) d), '[]'::jsonb),
    'unmapped', jsonb_build_object(
      'names', (SELECT count(*) FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pg g WHERE g.key LIKE 'n:%'),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('name', x.sample, 'units', x.units) ORDER BY x.units DESC, x.sample)
                          FROM (SELECT g.sample, g.units FROM pg g WHERE g.key LIKE 'n:%' AND g.units > 0
                                 ORDER BY g.units DESC, g.sample LIMIT 25) x), '[]'::jsonb)),
    'no_cost', jsonb_build_object(
      'active', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.cost_known),
      'selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known AND g.units > 0),
      'units', (SELECT coalesce(sum(g.units), 0) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.cost_known),
      'rows', coalesce((SELECT jsonb_agg(jsonb_build_object('product_id', x.id, 'name', x.name, 'units', x.units) ORDER BY x.units DESC, x.name)
                          FROM (SELECT c.id, c.name, g.units FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text
                                 WHERE NOT c.cost_known AND g.units > 0 ORDER BY g.units DESC, c.name LIMIT 15) x), '[]'::jsonb)),
    'not_products', coalesce((SELECT jsonb_agg(jsonb_build_object('kind', x.lkind, 'units', x.u, 'lines', x.n) ORDER BY x.u DESC)
                                FROM (SELECT lk.lkind, sum(lk.q_cur) AS u, sum(lk.n_cur) AS n FROM lk
                                       WHERE lk.lkind NOT IN ('product', 'gift') AND lk.n_cur > 0 GROUP BY 1) x), '[]'::jsonb),
    'not_tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND NOT c.tracked),
    'placeholder', (SELECT count(*) FROM pc c WHERE c.is_active AND c.placeholder),
    'inactive_selling', (SELECT count(*) FROM pc c JOIN pg g ON g.key = 'p:' || c.id::text WHERE NOT c.is_active AND g.units > 0)) AS j
),
-- ── valuation (owners; only when the count can be trusted) ─────────────────
va AS (
  SELECT round(coalesce(sum(c.stock_quantity * c.cost_price) FILTER (WHERE c.cost_known AND c.stock_quantity > 0), 0) * 61.5) AS cost_v,
         round(coalesce(sum(c.stock_quantity * c.price) FILTER (WHERE c.price > 0 AND c.stock_quantity > 0), 0) * 61.5) AS price_v,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0), 0) AS units_on_hand,
         coalesce(sum(c.stock_quantity) FILTER (WHERE c.stock_quantity > 0 AND c.cost_known), 0) AS units_costed
  FROM pc c WHERE c.is_active AND c.tracked
)
SELECT jsonb_build_object(
  'meta', jsonb_build_object('clock', 'sale', 'granularity', prm.gran, 'money', true, 'sources', to_jsonb(prm.srcs),
                             'today', to_char(prm.today, 'YYYY-MM-DD')),
  'trust', jsonb_build_object(
    'trusted', tr.trusted,
    'last_count', to_char((greatest(tr.last_count_at, tr.counted_at) AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_restock', to_char((tr.last_restock_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_deduction', to_char((tr.last_deduction_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_movement', to_char((tr.last_move_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'last_parcel', to_char((tr.last_parcel_at AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'parcels_since_deduction', tr.since_deduction,
    'ledger_out_window', tr.out_window, 'ledger_in_window', tr.in_window, 'ledger_moves_window', tr.moves_window,
    'parcels_window', tr.parcels_window,
    'counted', tr.counted_at IS NOT NULL,
    'mex_enabled', tr.mex_enabled,
    'mex_from', to_char((tr.mex_from AT TIME ZONE 'Europe/Skopje')::date, 'YYYY-MM-DD'),
    'mex_last_run', to_char(tr.mex_last_run AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD"T"HH24:MI')),
  'kpis', jsonb_build_object(
    'sales', kp.sales, 'sales_mex_only', kp.sales_mex_only,
    'units', kp.units, 'units_prev', CASE WHEN prm.pf IS NULL THEN NULL ELSE kp.units_prev END,
    'free_units', kp.free_units, 'units_catalogue', kp.units_catalogue, 'products_sold', kp.products_sold,
    'returned_units', kp.returned_units, 'returned_parcels', kp.returned_parcels, 'returned_mex_only', kp.returned_mex_only,
    'tracked', (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked),
    'active', (SELECT count(*) FROM pc c WHERE c.is_active),
    'out', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity <= 0) END,
    'low', CASE WHEN tr.trusted THEN (SELECT count(*) FROM pc c WHERE c.is_active AND c.tracked AND c.stock_quantity > 0
                                                                   AND c.stock_quantity < coalesce(c.low_stock_threshold, 0)) END),
  'queue', (SELECT j FROM qj),
  'queue_products', (SELECT j FROM qp),
  'products', (SELECT j FROM prj),
  'products_more', (SELECT jsonb_build_object('products', prx.products, 'units', prx.units) FROM prx),
  'trend', (SELECT j FROM tj),
  'hygiene', (SELECT j FROM hy),
  'valuation', CASE WHEN tr.trusted THEN (
    SELECT jsonb_build_object('cost_mkd', va.cost_v, 'price_mkd', va.price_v,
                              'coverage', CASE WHEN va.units_on_hand > 0 THEN round(va.units_costed::numeric / va.units_on_hand, 4) END)
    FROM va) END)
FROM prm, tr, kp
  $st$
  INTO v_out
  USING p_from, p_to_end, v_pf, v_pt, v_src, v_lo, v_fd, v_td, v_gran,
        public.report_excluded_phone8s(), (now() AT TIME ZONE 'Europe/Skopje')::date;

  v_out := jsonb_set(v_out, '{meta,has_prev}', to_jsonb(v_pf IS NOT NULL));
  IF coalesce(p_money, false) THEN
    RETURN v_out;
  END IF;
  v_out := public.insights_strip_money(jsonb_set(v_out, '{valuation}', 'null'::jsonb));
  RETURN jsonb_set(v_out, '{meta,money}', 'false'::jsonb);
END;
$fn$;

COMMENT ON FUNCTION public.insights_stock(timestamptz, timestamptz, timestamptz, timestamptz, text[], boolean) IS
  'GET /api/insights/stock (owner rules 2026-09-28): units sold per product (the cohort''s item lines, product_key folded, by source, trend; non-products and impossible quantities apart), units MEX returned in the period, the warehouse queue NOW (to pack / label printed, by age, per product), stock on hand only for tracked products with a trust verdict (20260942000100: a stock count exists AND the MEX stock ledger is on and ran in the last 3 hours — days of cover, out / low and valuation only when trusted), catalogue hygiene, valuation (owners). p_money = false strips every *_mkd key and the valuation. Migrations 20260941000500, 20260942000100.';

-- ── 12. Grants: service role only (+ the read-only verification role) ──────
REVOKE ALL ON FUNCTION public.stock_ts(text)                                        FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_mex_desired(timestamptz, boolean)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_mex_pending(timestamptz, boolean)               FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_mex_apply(text)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_count_apply(jsonb, uuid, text, text, boolean)   FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_mex_set(boolean, text, uuid, text)              FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_health(boolean)                                 FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.stock_restock(uuid, integer, uuid, text, text, text)  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stock_ts(text)                                        TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_mex_desired(timestamptz, boolean)               TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_mex_pending(timestamptz, boolean)               TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_mex_apply(text)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_count_apply(jsonb, uuid, text, text, boolean)   TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_mex_set(boolean, text, uuid, text)              TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_health(boolean)                                 TO service_role;
GRANT EXECUTE ON FUNCTION public.stock_restock(uuid, integer, uuid, text, text, text)  TO service_role;

-- scripts/verify-stock.mjs reads with read_only: true as supabase_read_only_user
-- (pg_read_all_data, BYPASSRLS). EXECUTE on these STABLE readers widens
-- nothing. Conditional for a fresh local database without the platform role.
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.stock_ts(text)                          TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_mex_desired(timestamptz, boolean) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_mex_pending(timestamptz, boolean) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_health(boolean)                   TO supabase_read_only_user;
  END IF;
END
$grant$;

-- ── 13. Schedule — every 30 minutes, after mex-reconcile (:07 / :37) and
-- web-sync (:03 / :33). Switched off it returns after one settings read. ────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stock-mex-apply') THEN
    PERFORM cron.unschedule('stock-mex-apply');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'stock-mex-apply',
  '12,42 * * * *',
  $job$SELECT public.stock_mex_apply('cron');$job$
);

NOTIFY pgrst, 'reload schema';
