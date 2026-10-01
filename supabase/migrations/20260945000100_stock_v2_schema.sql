-- ============================================================================
-- STOCK v2 — 1/5: the schema (owner request 01.10.2026; contract docs/STOCK-V2.md)
--
-- "Know exactly how much stock there is on any day, starting from the physical
-- count of 22.09." Stock v2 keeps ONE append-only ledger of signed article
-- quantities per warehouse (stock_moves) and derives every figure from it:
-- on-hand at any instant, the day sheet, the article series, the parcel pipeline.
--
-- Where the quantities come from (docs/STOCK-V2.md "Why Sigma is NOT the stock
-- truth for what leaves"):
--   * MEX parcels + the collabBox document goods lines (Sigma item codes, kits
--     already split) — what leaves and what comes back;
--   * Sigma staged documents — receipts, plant transfers, shop / B2B / export
--     sales, write-offs (never the MEX invoices 000217, АД Астра 000549 or the
--     04↔08 transfers);
--   * counts (the opening of 22.09 and every later попис), manual moves and
--     per-parcel overrides.
--
-- This migration only creates the tables, their guards and the seed rows — all
-- EMPTY and DARK (app_settings.stock_v2.enabled = false). The engine is in
-- 20260945000200 (resolver) · 0300 (desired / apply / reset) · 0400 (audited
-- writers) · 0500 (reports). Nothing here moves stock.
--
-- Security pattern for every table: RLS on, REVOKE ALL FROM PUBLIC, anon,
-- authenticated; GRANT ALL TO service_role. Reads go through the api. Writes go
-- through SECURITY DEFINER writers that open the transaction-local gate
-- `elyon.stock_write = 'on'` and write audit_log. The configuration, mapping,
-- count, manual-move and override tables carry a guard trigger that refuses
-- any write while the gate is closed (an FK cascade from a deleted product is
-- let through). stock_moves is append-only: UPDATE and DELETE are always
-- refused, INSERT only through the gate. The Sigma staging tables (written by
-- stock_sigma_ingest, workstream S, 20260945000650) and the cost tables
-- (workstream P, 20260945000600) are protected by RLS + grants only; their
-- writers own any further guard. stock_article_costs is append-only (UPDATE /
-- DELETE refused) per the contract.
--
-- app_settings.stock_v2 becomes an owner-only key: tg_app_settings_guard_owner_keys
-- is re-emitted from the LIVE body (drift-guarded: the 20260943001800,
-- 20260944000950 and 20260944000970 versions are accepted) with 'stock_v2' added.
--
-- Rollback (nothing depends on these tables until 0200–0500 are applied):
--   DROP TABLE … CASCADE for every table below; DELETE FROM app_settings WHERE
--   key = 'stock_v2'; re-emit the guard from 20260944000970.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regclass('public.mex_parcels') IS NULL
     OR to_regclass('public.collabbox_documents') IS NULL
     OR to_regclass('public.web_orders') IS NULL
     OR to_regclass('public.products') IS NULL
     OR to_regclass('public.audit_log') IS NULL
     OR to_regclass('public.app_settings') IS NULL
     OR to_regprocedure('public.tg_app_settings_guard_owner_keys()') IS NULL
     OR to_regprocedure('public.stock_ts(text)') IS NULL THEN
    RAISE EXCEPTION 'stock v2: apply 20260942000100 and the MEX / collabBox / web mirrors first';
  END IF;
END
$dep$;

-- ── 0. drift guard: the owner-keys guard is re-emitted below ────────────────
DO $drift$
DECLARE v_md5 text;
BEGIN
  SELECT md5(replace(p.prosrc, chr(13), '')) INTO v_md5
    FROM pg_proc p WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()');
  IF v_md5 IS NULL OR v_md5 NOT IN (
       '85b5d14002b3cdbc6615bf8438742a1e',   -- 20260943001800 (… mex_push)
       'e8bab1d453fb9bab1640c7d84c86e7c7',   -- 20260944000950 (… link_lead_parcels)
       '6f463680dc3a60f264e7e702bb1e748c',   -- 20260944000970 (… leads_parcel_orders) — live 01.10.2026
       'b0fa4b0bafa78151cdac7a72df5420b9')   -- this migration (re-run)
  THEN
    RAISE EXCEPTION 'stock v2: tg_app_settings_guard_owner_keys changed since this migration was written (md5 %) — re-emit it from the live body', v_md5;
  END IF;
END
$drift$;

-- ── 1. the write gate ───────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.tg_stock_v2_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  -- a foreign-key cascade (a deleted product) runs one trigger level deeper
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  IF coalesce(current_setting('elyon.stock_write', true), '') <> 'on' THEN
    RAISE EXCEPTION '% is written only by the stock v2 writers (audited)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$fn$;

COMMENT ON FUNCTION public.tg_stock_v2_guard() IS
  'Stock v2 write gate: refuses INSERT / UPDATE / DELETE unless the transaction-local setting elyon.stock_write = ''on'' (opened only by the audited SECURITY DEFINER writers of 20260945000300 / 0400). A cascade delete from a deleted product passes. Migration 20260945000100.';

CREATE OR REPLACE FUNCTION public.tg_stock_moves_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'stock_moves is append-only: a change is a new (correction) row, never an UPDATE or DELETE'
      USING ERRCODE = '42501';
  END IF;
  IF coalesce(current_setting('elyon.stock_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'stock_moves is written only by stock_v2_apply() / stock_v2_reset()'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

COMMENT ON FUNCTION public.tg_stock_moves_guard() IS
  'stock_moves is append-only: UPDATE / DELETE always refused, INSERT only while elyon.stock_write = ''on'' (stock_v2_apply / stock_v2_reset). Migration 20260945000100.';

CREATE OR REPLACE FUNCTION public.tg_stock_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: add a new row instead of changing one', TG_TABLE_NAME
    USING ERRCODE = '42501';
END
$fn$;

COMMENT ON FUNCTION public.tg_stock_append_only() IS
  'Refuses UPDATE / DELETE on an append-only stock table (stock_article_costs). Migration 20260945000100.';

REVOKE ALL ON FUNCTION public.tg_stock_v2_guard()     FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_stock_moves_guard()  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.tg_stock_append_only()  FROM PUBLIC, anon, authenticated;

-- ── 2. warehouses, keys, routes ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_warehouses (
  id               smallint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  code             text NOT NULL UNIQUE CONSTRAINT stock_warehouses_code_check CHECK (code ~ '^[a-z0-9_]{2,24}$'),
  name             text NOT NULL,
  role             text NOT NULL CONSTRAINT stock_warehouses_role_check
                   CHECK (role IN ('main', 'shipping', 'lab', 'damaged', 'writeoff', 'plant', 'review', 'other')),
  tracked          boolean NOT NULL DEFAULT false,
  sellable         boolean NOT NULL DEFAULT false,
  sigma_moves_from timestamptz,
  active           boolean NOT NULL DEFAULT true,
  sort             integer NOT NULL DEFAULT 100,
  note             text
);

COMMENT ON TABLE public.stock_warehouses IS
  'Stock v2 warehouses. Only tracked = true warehouses hold ledger quantities; an untracked one (wh08 under review, writeoff, lab) is only a Sigma key whose side of a document is ignored. sigma_moves_from: Sigma documents dated before it never move this warehouse (they are in its opening count). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_warehouse_keys (
  system       text NOT NULL CONSTRAINT stock_warehouse_keys_system_check CHECK (system IN ('sigma', 'collabbox')),
  key          text NOT NULL,
  warehouse_id smallint NOT NULL REFERENCES public.stock_warehouses(id),
  PRIMARY KEY (system, key)
);

COMMENT ON TABLE public.stock_warehouse_keys IS
  'The outside names of a stock v2 warehouse: a Sigma object (Ф00001-04 — company-object, matched on object_from/_to as written, or company || ''-'' || object) or a collabBox warehouse (the tracking-id prefix, 002). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_parcel_routes (
  id                  integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  priority            integer NOT NULL,
  match_account       text CONSTRAINT stock_parcel_routes_account_check CHECK (match_account IN ('natura', 'bio_natural')),
  match_series        text,
  match_shape         text CONSTRAINT stock_parcel_routes_shape_check CHECK (match_shape IN ('collabbox', 'web', 'crm', 'other')),
  warehouse_id        smallint NOT NULL REFERENCES public.stock_warehouses(id),
  return_warehouse_id smallint REFERENCES public.stock_warehouses(id),
  valid_from          timestamptz NOT NULL,
  valid_to            timestamptz,
  active              boolean NOT NULL DEFAULT true,
  CONSTRAINT stock_parcel_routes_window_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

COMMENT ON TABLE public.stock_parcel_routes IS
  'Which warehouse a MEX parcel leaves (warehouse_id, at created_at_mex) and returns to (coalesce(return_warehouse_id, warehouse_id), at returned_at). The LOWEST priority number among the active routes whose filters match (NULL = any) and whose [valid_from, valid_to) holds the event time wins. A parcel created before every route''s valid_from is pre_opening (nothing leaves — the opening count saw the shelf); its later return still comes back. Migration 20260945000100.';

-- ── 3. articles, kits, recipes, exemptions, aliases ─────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_articles (
  code             text PRIMARY KEY CONSTRAINT stock_articles_code_check CHECK (code ~ '^[0-9]{6}$' OR code ~ '^L[0-9]{5}$'),
  name             text NOT NULL,
  unit             text NOT NULL DEFAULT 'КОМ',
  sigma_class      text,
  brand            text,
  is_set           boolean NOT NULL DEFAULT false,
  active           boolean NOT NULL DEFAULT true,
  source           text NOT NULL DEFAULT 'sigma' CONSTRAINT stock_articles_source_check CHECK (source IN ('sigma', 'local')),
  last_seen_export timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_articles IS
  'Stock v2 articles = Sigma items (6-digit code) or local ones (L + 5 digits). The unit of every ledger quantity. is_set: a kit, expanded into stock_article_kits components wherever a parcel line names it. Written by stock_articles_upsert(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_article_kits (
  kit_code       text NOT NULL REFERENCES public.stock_articles(code),
  component_code text NOT NULL REFERENCES public.stock_articles(code),
  qty            numeric(10,3) NOT NULL CONSTRAINT stock_article_kits_qty_check CHECK (qty > 0),
  source_ref     text,
  observed_at    timestamptz,
  PRIMARY KEY (kit_code, component_code),
  CONSTRAINT stock_article_kits_self_check CHECK (kit_code <> component_code)
);

COMMENT ON TABLE public.stock_article_kits IS
  'A kit''s components (one level). collabBox lines already arrive split; this is for recipes, aliases and overrides that name a kit. Written by stock_article_kits_upsert(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.product_articles (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id   uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  article_code text NOT NULL REFERENCES public.stock_articles(code),
  qty          numeric(10,3) NOT NULL CONSTRAINT product_articles_qty_check CHECK (qty > 0 AND qty <= 100),
  role         text NOT NULL DEFAULT 'main' CONSTRAINT product_articles_role_check CHECK (role IN ('main', 'component', 'gift')),
  valid_from   timestamptz NOT NULL DEFAULT '-infinity',
  valid_to     timestamptz,
  status       text NOT NULL DEFAULT 'proposed' CONSTRAINT product_articles_status_check CHECK (status IN ('proposed', 'approved', 'rejected')),
  source       text,
  confidence   text CONSTRAINT product_articles_confidence_check CHECK (confidence IN ('high', 'medium', 'low')),
  approved_by  uuid,
  approved_at  timestamptz,
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT product_articles_window_check CHECK (valid_to IS NULL OR valid_to > valid_from)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_product_articles_live
  ON public.product_articles (product_id, article_code, valid_from) WHERE status <> 'rejected';
CREATE INDEX IF NOT EXISTS idx_product_articles_approved
  ON public.product_articles (product_id) WHERE status = 'approved';

COMMENT ON TABLE public.product_articles IS
  'The recipe: which articles (and how many) one unit of a CRM product is, valid in [valid_from, valid_to) at the parcel''s creation. ONLY status = approved rows move stock or cost. Written by product_articles_set() / product_articles_approve(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.product_stock_exempt (
  product_id uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  reason     text NOT NULL,
  set_by     uuid,
  set_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.product_stock_exempt IS
  'CRM products that never move stock (delivery, ПОЕН loyalty points, flyers, services). Written by product_stock_exempt_set(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_article_aliases (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  source       text NOT NULL CONSTRAINT stock_article_aliases_source_check
               CHECK (source IN ('collabbox_code', 'collabbox_name', 'web_product', 'web_sku', 'name_any')),
  key          text NOT NULL,
  kind         text NOT NULL CONSTRAINT stock_article_aliases_kind_check CHECK (kind IN ('article', 'not_stock')),
  article_code text REFERENCES public.stock_articles(code),
  qty          numeric(10,3) NOT NULL DEFAULT 1 CONSTRAINT stock_article_aliases_qty_check CHECK (qty > 0 AND qty <= 100),
  status       text NOT NULL DEFAULT 'proposed' CONSTRAINT stock_article_aliases_status_check CHECK (status IN ('proposed', 'approved')),
  note         text,
  set_by       uuid,
  set_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_article_aliases_target_check CHECK ((kind = 'article') = (article_code IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_article_aliases
  ON public.stock_article_aliases (source, key, coalesce(article_code, ''));

COMMENT ON TABLE public.stock_article_aliases IS
  'A line text / code → article(s) × qty, or not_stock. key is normalised by stock_v2_alias_key() (codes / SKUs upper-trimmed, names product_alias_norm). Only approved rows are used. Written by stock_article_alias_set(). Migration 20260945000100.';

-- ── 4. costs (owners only; workstream P writes them) ────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_article_costs (
  id           bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  article_code text NOT NULL REFERENCES public.stock_articles(code),
  cost_mkd     numeric(14,4) NOT NULL CONSTRAINT stock_article_costs_cost_check CHECK (cost_mkd >= 0),
  valid_from   timestamptz NOT NULL,
  source       text NOT NULL CONSTRAINT stock_article_costs_source_check
               CHECK (source IN ('sigma_calcbuyprice', 'sigma_last_buyprice', 'owner')),
  basis        text,
  source_ref   text,
  flags        text[] NOT NULL DEFAULT '{}',
  recorded_by  uuid,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stock_article_costs_key UNIQUE (article_code, valid_from, source)
);

CREATE INDEX IF NOT EXISTS idx_stock_article_costs_lookup
  ON public.stock_article_costs (article_code, valid_from DESC);

COMMENT ON TABLE public.stock_article_costs IS
  'Purchase cost per article in MKD excluding VAT (Sigma CalcBuyPrice; a deliberate exception to "store EUR" — these are Sigma book values), valid from valid_from; on a tie the owner value wins. Append-only. OWNERS ONLY. Migration 20260945000100 (writers: 20260945000600).';

CREATE TABLE IF NOT EXISTS public.product_cost_history (
  product_id uuid NOT NULL REFERENCES public.products(id) ON DELETE CASCADE,
  valid_from timestamptz NOT NULL,
  valid_to   timestamptz,
  cost_mkd   numeric(14,4),
  complete   boolean NOT NULL DEFAULT false,
  components jsonb NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (product_id, valid_from)
);

COMMENT ON TABLE public.product_cost_history IS
  'A CRM product''s cost (MKD) through its approved recipe, per validity window; complete = every recipe article costed. Derived by product_costs_rebuild() (20260945000600). OWNERS ONLY. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.products_cost_legacy (
  product_id     uuid PRIMARY KEY REFERENCES public.products(id) ON DELETE CASCADE,
  cost_price_eur numeric,
  archived_at    timestamptz NOT NULL DEFAULT now(),
  archived_by    uuid
);

COMMENT ON TABLE public.products_cost_legacy IS
  'The old hand-entered products.cost_price (EUR), archived once by product_costs_rebuild(p_archive_legacy => true). OWNERS ONLY. Migration 20260945000100.';

-- ── 5. counts, manual moves, parcel overrides ───────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_wh_counts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  warehouse_id   smallint NOT NULL REFERENCES public.stock_warehouses(id),
  counted_at     timestamptz NOT NULL,
  kind           text NOT NULL CONSTRAINT stock_wh_counts_kind_check CHECK (kind IN ('opening', 'full', 'partial')),
  source         text NOT NULL DEFAULT 'manual' CONSTRAINT stock_wh_counts_source_check CHECK (source IN ('manual', 'sigma_variant', 'xlsx')),
  source_ref     text,
  status         text NOT NULL DEFAULT 'pending' CONSTRAINT stock_wh_counts_status_check CHECK (status IN ('pending', 'approved', 'void')),
  packed_counted boolean NOT NULL DEFAULT false,
  note           text,
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  approved_by    uuid,
  approved_at    timestamptz,
  voided_by      uuid,
  voided_at      timestamptz,
  void_reason    text
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_stock_wh_counts_opening
  ON public.stock_wh_counts (warehouse_id) WHERE kind = 'opening' AND status = 'approved';
CREATE INDEX IF NOT EXISTS idx_stock_wh_counts_wh_at
  ON public.stock_wh_counts (warehouse_id, counted_at) WHERE status = 'approved';

COMMENT ON TABLE public.stock_wh_counts IS
  'A physical count (попис) of one warehouse at counted_at. Only approved counts move the ledger: per counted article the adjustment = counted − (previous counted + every non-count move since), at counted_at. packed_counted: the counters also counted boxed parcels at MEX 8 (already deducted), so those units are taken off the counted figure. At most one approved opening per warehouse. Written by stock_v2_count_save() / _approve() / _void(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_wh_count_lines (
  count_id           uuid NOT NULL REFERENCES public.stock_wh_counts(id) ON DELETE CASCADE,
  article_code       text NOT NULL REFERENCES public.stock_articles(code),
  counted_qty        numeric(14,3) NOT NULL CONSTRAINT stock_wh_count_lines_qty_check CHECK (counted_qty >= 0),
  system_qty_at_save numeric(14,3),
  PRIMARY KEY (count_id, article_code)
);

COMMENT ON TABLE public.stock_wh_count_lines IS
  'One counted article of a stock_wh_counts row; system_qty_at_save = what the system showed when the count was saved (information).';

CREATE TABLE IF NOT EXISTS public.stock_manual_moves (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind       text NOT NULL CONSTRAINT stock_manual_moves_kind_check
             CHECK (kind IN ('receipt', 'transfer', 'adjust', 'writeoff', 'damaged', 'unpack')),
  from_wh    smallint REFERENCES public.stock_warehouses(id),
  to_wh      smallint REFERENCES public.stock_warehouses(id),
  event_at   timestamptz NOT NULL,
  doc_ref    text,
  note       text,
  status     text NOT NULL DEFAULT 'approved' CONSTRAINT stock_manual_moves_status_check CHECK (status IN ('approved', 'void')),
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  voided_by  uuid,
  voided_at  timestamptz,
  CONSTRAINT stock_manual_moves_sides_check CHECK (from_wh IS NOT NULL OR to_wh IS NOT NULL)
);

COMMENT ON TABLE public.stock_manual_moves IS
  'A move typed in the CRM (receipt, transfer, adjust, writeoff, damaged, unpack). Approved rows move the ledger at event_at; void ones are negated. Written by stock_v2_manual_move(). Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_manual_move_lines (
  move_id      uuid NOT NULL REFERENCES public.stock_manual_moves(id) ON DELETE CASCADE,
  article_code text NOT NULL REFERENCES public.stock_articles(code),
  qty          numeric(14,3) NOT NULL CONSTRAINT stock_manual_move_lines_qty_check CHECK (qty > 0),
  PRIMARY KEY (move_id, article_code)
);

CREATE TABLE IF NOT EXISTS public.stock_parcel_overrides (
  tracking_id text PRIMARY KEY,
  action      text NOT NULL CONSTRAINT stock_parcel_overrides_action_check
              CHECK (action IN ('exclude', 'lines', 'route', 'unpacked', 'damaged_return')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_at    timestamptz,
  active      boolean NOT NULL DEFAULT true,
  note        text,
  set_by      uuid,
  set_at      timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_parcel_overrides IS
  'An owner''s ruling on one parcel: exclude (moves nothing) · lines (payload.lines = [{code, qty}] replace every other source) · route (payload.warehouse / payload.return_warehouse codes) · unpacked (the label never shipped: the goods come back as unpack_in at event_at) · damaged_return (the return goes to the damaged warehouse). Written by stock_v2_parcel_override(). Migration 20260945000100.';

-- ── 6. the ledger ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.stock_runs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger     text NOT NULL DEFAULT 'cron',
  dry         boolean NOT NULL DEFAULT false,
  status      text NOT NULL DEFAULT 'running' CONSTRAINT stock_runs_status_check CHECK (status IN ('running', 'ok', 'failed')),
  stats       jsonb,
  error       text,
  actor       uuid,
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_stock_runs_started ON public.stock_runs (started_at DESC);

COMMENT ON TABLE public.stock_runs IS
  'One row per stock_v2_apply() / stock_v2_reset() run that did work (a switched-off cron tick writes nothing). The trust verdict reads the last ok non-dry run. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_moves (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  article_code text NOT NULL REFERENCES public.stock_articles(code),
  warehouse_id smallint NOT NULL REFERENCES public.stock_warehouses(id),
  qty          numeric(14,3) NOT NULL CONSTRAINT stock_moves_qty_check CHECK (qty <> 0),
  kind         text NOT NULL CONSTRAINT stock_moves_kind_check CHECK (kind IN (
                 'opening', 'count_adjust', 'parcel_out', 'return_in', 'unpack_in',
                 'transfer_out', 'transfer_in', 'receipt', 'production_in', 'production_use',
                 'b2b_out', 'b2b_return_in', 'export_out', 'shop_out', 'shop_return_in',
                 'writeoff', 'damaged_in', 'adjust')),
  event_at     timestamptz NOT NULL,
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  source       text NOT NULL CONSTRAINT stock_moves_source_check CHECK (source IN ('mex', 'count', 'sigma', 'manual', 'override')),
  source_key   text NOT NULL,
  correction   boolean NOT NULL DEFAULT false,
  provisional  boolean NOT NULL DEFAULT false,
  tracking_id  text,
  sigma_doc    text,
  count_id     uuid,
  manual_id    uuid,
  lines_source text CONSTRAINT stock_moves_lines_source_check CHECK (lines_source IN ('override', 'collabbox', 'web', 'crm')),
  run_id       uuid REFERENCES public.stock_runs(id)
);

CREATE INDEX IF NOT EXISTS idx_stock_moves_wh_article_at ON public.stock_moves (warehouse_id, article_code, event_at);
CREATE INDEX IF NOT EXISTS idx_stock_moves_event_at       ON public.stock_moves (event_at);
CREATE INDEX IF NOT EXISTS idx_stock_moves_source_key     ON public.stock_moves (source_key);
CREATE INDEX IF NOT EXISTS idx_stock_moves_tracking       ON public.stock_moves (tracking_id) WHERE tracking_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_moves_sigma_doc      ON public.stock_moves (sigma_doc) WHERE sigma_doc IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_stock_moves_run            ON public.stock_moves (run_id);

COMMENT ON TABLE public.stock_moves IS
  'THE stock v2 ledger: signed article quantities per warehouse at event_at. On-hand at t = Σ qty of the moves before t (a count at exactly t included). Append-only; a group = (source_key, kind, article_code, warehouse_id, event_at); stock_v2_apply() writes only the difference between stock_v2_desired() and the applied groups, a difference against an already applied group flagged correction. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_parcel_state (
  tracking_id         text PRIMARY KEY,
  warehouse_id        smallint REFERENCES public.stock_warehouses(id),
  return_warehouse_id smallint REFERENCES public.stock_warehouses(id),
  lines_source        text,
  state               text NOT NULL CONSTRAINT stock_parcel_state_state_check CHECK (state IN (
                        'moved', 'partial', 'unmapped', 'no_lines', 'no_route', 'test_phone',
                        'excluded', 'pre_opening', 'waiting_lines')),
  units_out           numeric(14,3) NOT NULL DEFAULT 0,
  units_back          numeric(14,3) NOT NULL DEFAULT 0,
  unmapped            jsonb NOT NULL DEFAULT '[]'::jsonb,
  flags               text[] NOT NULL DEFAULT '{}',
  fingerprint         text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_parcel_state_state ON public.stock_parcel_state (state);

COMMENT ON TABLE public.stock_parcel_state IS
  'The verdict of the last applying run for every parcel in scope (stock_v2_parcels()). Written by stock_v2_apply(). Migration 20260945000100.';

-- ── 7. Sigma staging (written by stock_sigma_ingest, 20260945000650) ────────
CREATE TABLE IF NOT EXISTS public.stock_sigma_batches (
  batch_id    text PRIMARY KEY,
  source      text NOT NULL CONSTRAINT stock_sigma_batches_source_check CHECK (source IN ('csv', 'connector')),
  mode        text NOT NULL CONSTRAINT stock_sigma_batches_mode_check CHECK (mode IN ('delta', 'snapshot', 'items', 'balances')),
  exported_at timestamptz,
  window_from date,
  window_to   date,
  counts      jsonb,
  result      jsonb,
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.stock_sigma_docs (
  doc_key          text PRIMARY KEY,
  wyear            text,
  doc_type         text NOT NULL,
  doc_no           text,
  doc_date         date NOT NULL,
  posted_at        timestamptz,
  created_at_sigma timestamptz,
  created_by       text,
  last_change_by   text,
  status           text,
  company_from     text,
  object_from      text,
  company_to       text,
  object_to        text,
  client_code      text,
  client_name      text,
  lines            jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash     text,
  versions         integer NOT NULL DEFAULT 1,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  last_changed_at  timestamptz,
  vanished_at      timestamptz,
  excluded_reason  text
);

CREATE INDEX IF NOT EXISTS idx_stock_sigma_docs_date ON public.stock_sigma_docs (doc_date);

COMMENT ON TABLE public.stock_sigma_docs IS
  'A staged Sigma document: doc_key = ''<WYear>|<DocType>|<DocNo>''; lines = [{item_code, qty, side: in | out}] summed per item and side. A line''s side says which object it touches: out = object_from (the goods leave it), in = object_to (they arrive). stock_v2_desired() turns a document that is not vanished, not excluded (excluded_reason, stock_sigma_rules) and of an included type into moves at doc_date 12:00 Skopje. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_sigma_doc_versions (
  doc_key      text NOT NULL REFERENCES public.stock_sigma_docs(doc_key) ON DELETE CASCADE,
  version      integer NOT NULL,
  doc_date     date,
  content_hash text,
  lines        jsonb,
  seen_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_key, version)
);

CREATE TABLE IF NOT EXISTS public.stock_sigma_doc_types (
  doc_type    text PRIMARY KEY,
  name        text,
  direction   text NOT NULL CONSTRAINT stock_sigma_doc_types_direction_check CHECK (direction IN ('in', 'out', 'transfer')),
  ledger_kind text CONSTRAINT stock_sigma_doc_types_kind_check CHECK (ledger_kind IN (
                'receipt', 'production_in', 'b2b_return_in', 'shop_return_in',
                'shop_out', 'export_out', 'b2b_out', 'writeoff', 'production_use',
                'transfer_in', 'transfer_out')),
  include     boolean NOT NULL DEFAULT false
);

COMMENT ON TABLE public.stock_sigma_doc_types IS
  'Sigma document types: direction in / out / transfer and the ledger kind they become. A type that is missing or include = false never moves stock (review). Seeded by 20260945000650. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_sigma_rules (
  id      integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  match   jsonb NOT NULL,
  action  text NOT NULL CONSTRAINT stock_sigma_rules_action_check CHECK (action IN ('exclude', 'include')),
  reason  text NOT NULL,
  active  boolean NOT NULL DEFAULT true,
  set_by  uuid,
  set_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_sigma_rules IS
  'Which staged Sigma documents never move stock. match: {"client_code"} · {"doc_type"} · {"doc_key"} · {"objects":[A,B]} (a document between A and B, either way). A document is excluded when an active exclude rule matches and no active include rule does. Migration 20260945000100.';

CREATE TABLE IF NOT EXISTS public.stock_sigma_balances (
  taken_at       timestamptz NOT NULL,
  company        text NOT NULL,
  object         text NOT NULL,
  item_code      text NOT NULL,
  wyear          text NOT NULL,
  qty            numeric(14,3),
  calc_buy_price numeric(14,4),
  PRIMARY KEY (taken_at, company, object, item_code, wyear)
);

CREATE TABLE IF NOT EXISTS public.stock_sigma_drafts (
  doc_key     text PRIMARY KEY,
  doc_date    date,
  object_from text,
  object_to   text,
  lines       jsonb NOT NULL DEFAULT '[]'::jsonb,
  seen_at     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.stock_sigma_drafts IS
  'Sigma drafts ("најавено") — shown, never move stock. Migration 20260945000100.';

-- ── 8. guards, RLS, grants ──────────────────────────────────────────────────
DO $guards$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_warehouses', 'stock_warehouse_keys', 'stock_parcel_routes',
                           'stock_articles', 'stock_article_kits', 'product_articles',
                           'product_stock_exempt', 'stock_article_aliases',
                           'stock_wh_counts', 'stock_wh_count_lines',
                           'stock_manual_moves', 'stock_manual_move_lines', 'stock_parcel_overrides',
                           'stock_parcel_state']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%s_guard ON public.%I', t, t);
    EXECUTE format('CREATE TRIGGER trg_%s_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.tg_stock_v2_guard()', t, t);
  END LOOP;

  FOREACH t IN ARRAY ARRAY['stock_warehouses', 'stock_warehouse_keys', 'stock_parcel_routes',
                           'stock_articles', 'stock_article_kits', 'product_articles',
                           'product_stock_exempt', 'stock_article_aliases',
                           'stock_article_costs', 'product_cost_history', 'products_cost_legacy',
                           'stock_wh_counts', 'stock_wh_count_lines',
                           'stock_manual_moves', 'stock_manual_move_lines', 'stock_parcel_overrides',
                           'stock_runs', 'stock_moves', 'stock_parcel_state',
                           'stock_sigma_batches', 'stock_sigma_docs', 'stock_sigma_doc_versions',
                           'stock_sigma_doc_types', 'stock_sigma_rules', 'stock_sigma_balances',
                           'stock_sigma_drafts']
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT ALL ON public.%I TO service_role', t);
  END LOOP;

  -- the identity sequences too (the platform's default privileges grant them to the API roles)
  FOR t IN SELECT pg_get_serial_sequence('public.' || x.tbl, 'id')
             FROM unnest(ARRAY['stock_warehouses', 'stock_parcel_routes', 'stock_article_aliases',
                               'stock_article_costs', 'stock_moves', 'stock_sigma_rules']) x(tbl)
  LOOP
    IF t IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated', t);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE %s TO service_role', t);
    END IF;
  END LOOP;
END
$guards$;

DROP TRIGGER IF EXISTS trg_stock_moves_guard ON public.stock_moves;
CREATE TRIGGER trg_stock_moves_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.stock_moves
  FOR EACH ROW EXECUTE FUNCTION public.tg_stock_moves_guard();

DROP TRIGGER IF EXISTS trg_stock_moves_no_truncate ON public.stock_moves;
CREATE TRIGGER trg_stock_moves_no_truncate
  BEFORE TRUNCATE ON public.stock_moves
  FOR EACH STATEMENT EXECUTE FUNCTION public.tg_stock_append_only();

DROP TRIGGER IF EXISTS trg_stock_article_costs_append_only ON public.stock_article_costs;
CREATE TRIGGER trg_stock_article_costs_append_only
  BEFORE UPDATE OR DELETE ON public.stock_article_costs
  FOR EACH ROW EXECUTE FUNCTION public.tg_stock_append_only();

-- ── 9. seeds ────────────────────────────────────────────────────────────────
SELECT set_config('elyon.stock_write', 'on', true);

INSERT INTO public.stock_warehouses (code, name, role, tracked, sellable, sigma_moves_from, active, sort, note)
VALUES
  ('main',     'Главен магацин Скопје',             'main',     true,  true,  '2026-09-22 00:00:00+02', true, 10,
   'The counted warehouse (Sigma Ф00001-04, collabBox 002) and the one every MEX parcel leaves. Opening = the 22.09.2026 morning count.'),
  ('wh08',     'Сигма 08 Кол Центар (преглед)',     'review',   false, false, NULL, true, 20,
   'Sigma Ф00001-08 is under review (owner 01.10.2026): not tracked, 04↔08 transfers excluded.'),
  ('damaged',  'Оштетена роба',                     'damaged',  true,  false, NULL, true, 30,
   'Damaged goods (collabBox 014): damaged returns and manual damaged moves land here; never sellable.'),
  ('writeoff', 'Отпис (Сигма Ф00001-11)',           'writeoff', false, false, NULL, true, 40,
   'Sigma Ф00001-11: a transfer into it leaves the tracked side only.'),
  ('lab',      'Лабораторија (Сигма Ф00002-00)',    'lab',      false, false, NULL, true, 50,
   'Sigma Ф00002-00 (Labs / plant): not tracked, its side of a document is ignored.')
ON CONFLICT (code) DO NOTHING;

INSERT INTO public.stock_warehouse_keys (system, key, warehouse_id)
SELECT k.system, k.key, w.id
FROM (VALUES ('sigma', 'Ф00001-04', 'main'), ('collabbox', '002', 'main'),
             ('sigma', 'Ф00001-08', 'wh08'),
             ('collabbox', '014', 'damaged'),
             ('sigma', 'Ф00001-11', 'writeoff'),
             ('sigma', 'Ф00002-00', 'lab')) k(system, key, code)
JOIN public.stock_warehouses w ON w.code = k.code
ON CONFLICT (system, key) DO NOTHING;

INSERT INTO public.stock_parcel_routes (priority, warehouse_id, valid_from, active)
SELECT 100, w.id, '2026-09-22 00:00:00+02', true
FROM public.stock_warehouses w
WHERE w.code = 'main'
  AND NOT EXISTS (SELECT 1 FROM public.stock_parcel_routes);

INSERT INTO public.stock_sigma_rules (match, action, reason, active)
SELECT r.match, 'exclude', r.reason, true
FROM (VALUES
  ('{"client_code":"000217"}'::jsonb, 'МЕКС ПОШТА — the monthly MEX COD invoice; parcels move stock from MEX + collabBox instead'),
  ('{"client_code":"000549"}'::jsonb, 'АД Астра — inter-company invoice, not a physical move out of 04'),
  ('{"objects":["Ф00001-04","Ф00001-08"]}'::jsonb, 'Transfers between 04 and 08 — Sigma 08 is under review (owner 01.10.2026)')
) r(match, reason)
WHERE NOT EXISTS (SELECT 1 FROM public.stock_sigma_rules x WHERE x.match = r.match);

SELECT set_config('elyon.stock_write', 'off', true);

INSERT INTO public.app_settings (key, value)
VALUES ('stock_v2', '{"enabled": false, "free_units": "deduct", "stale_label_days": 14,
                      "relabel_window_days": 3,
                      "sigma": {"ingest": false, "apply_on_ingest": true, "costs_follow": false},
                      "profit": {"cost_source": "legacy", "extra_goods": false}}'::jsonb)
ON CONFLICT (key) DO NOTHING;

-- ── 10. app_settings.stock_v2 is an owner-only key ──────────────────────────
-- Re-emitted from the LIVE body (20260944000970, md5 6f463680…) with ONE edit:
-- 'stock_v2' joins the list. The keys of 20260944000950 / 0970 are kept even
-- where those migrations are not applied yet (guarding an absent key is harmless).
CREATE OR REPLACE FUNCTION public.tg_app_settings_guard_owner_keys()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _guarded constant text[] := ARRAY['no_parcel_rule', 'stock_mex_movements', 'stock_counted_at', 'mex_push', 'link_lead_parcels', 'leads_parcel_orders', 'stock_v2'];
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

NOTIFY pgrst, 'reload schema';

COMMIT;
