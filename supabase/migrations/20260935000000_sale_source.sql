-- ============================================================================
-- SALE SOURCE — where every order came from, fixed at birth (2026-09-27)
--
-- Owner rules (Mile, 2026-09-27 — law for everything that reads this column):
--   1. SOURCE = how the order ARRIVED. Through a lead intake (the AlterCPA
--      bridge, the web shop) it is a LEAD; created by our own agent it is
--      ElyonCRM (a cold call to an existing client). Decided by INTAKE PATH,
--      never by "the first status was pending": 4.468 AlterCPA leads were
--      inserted directly in a final status (mostly the 18.09 catch-up). An
--      AlterCPA lead from a returning customer stays AlterCPA — the old
--      order_channel() called those "prediction" because the phone had ordered
--      before (22.09: 40 orders / 107.282 ден in the wrong card).
--   2. Source wins for money; the TEAM is shown next to it, never instead of it
--      (sales_team_members, migration 20260935000100).
--
-- What this migration adds:
--   orders.sale_source         altercpa | web | elyon_crm | collabbox |
--                              affiliate | legacy
--   orders.sale_source_detail  the sub-channel (table below)
--   is_synthetic_product_name()  SQL twin of src/lib/utils.ts
--   elyon_crm_sale_detail()      the ElyonCRM sub-channel
--   classify_sale_source()       THE classifier — the insert trigger and
--                                scripts/backfill-sale-source.mjs both call it,
--                                so a live insert and the backfill can never
--                                disagree
--   trg_orders_sale_source_fill  BEFORE INSERT: fills both columns when NULL;
--                                a duplicate (orders.duplicated_from) inherits
--                                its original's source
--   trg_orders_sale_source_lock  BEFORE UPDATE OF sale_source,
--                                sale_source_detail: once set, both are
--                                write-once (RAISE) unless the transaction sets
--                                elyon.allow_source_change = 'on'
--
-- NO BACKFILL HERE. The ~105k existing rows are filled by
-- scripts/backfill-sale-source.mjs (dry-run matrix → owner review → --apply
-- in 5.000-row chunks, trg_orders_updated_at suppressed). Until then old rows
-- read NULL and every report must treat NULL as "not classified yet".
--
-- ── The classifier (ordered — the first matching rule wins) ─────────────────
--   source_type = 'monadon_legacy'                     → legacy / monadon_legacy
--   source_type = 'altercpa' OR external_source = 'altercpa'
--                                                      → altercpa / bridge (the
--                                                        live sync) | history
--                                                        (the 2026-08 import)
--   source_type = 'affiliate'                          → affiliate / partner
--   source_type IN (opencart, opencart_abandoned, inbound_lead)
--                                                      → web / <source_type>
--   external_source ILIKE 'naturatherapy%'             → web / <external_source>
--   external_source = 'collabbox'                      → collabbox / by DocNumber
--                                                        series (split_part(
--                                                        external_order_id,'-',2)):
--                                                        9102, 9100 teleshop ·
--                                                        9108 social · 9103
--                                                        leads_out · 9110 leads ·
--                                                        anything else = the
--                                                        series itself
--   source_type IN (manual, prediction_lead)           → elyon_crm /
--                                                        disposition | prediction_list | direct
--   anything else                                      → legacy / <source_type>
--
-- The ElyonCRM detail is decided in THIS order, deliberately:
--   disposition      price 0/NULL or a synthetic product name — the 0 ден
--                    cancel/trash call-outcome rows /calls writes. They carry
--                    prediction_list_id too (the api stamps the list on EVERY
--                    status so a list's cancels count), so testing the list
--                    first would file 6.881 "no" rows as list sales.
--   prediction_list  a real sale made while the customer sat on a list.
--   direct           a real sale with no list.
--
-- Live mix on 2026-09-27 (all 4 combinations that exist; read-only dry run):
--   import   + altercpa   80.318 → altercpa / history
--   altercpa + altercpa    9.293 → altercpa / bridge
--   import   + collabbox   8.207 → collabbox / teleshop 3.210 · leads 2.497 ·
--                                  leads_out 2.352 · social 147 · 9225 1
--   manual   + (none)      7.648 → elyon_crm / disposition 6.885 ·
--                                  prediction_list 729 · direct 5; 29 of the
--                                  30 manual duplicates inherit altercpa from
--                                  their original (28 bridge, 1 history)
-- ============================================================================

-- Fail fast rather than queue every orders query behind this migration's
-- ACCESS EXCLUSIVE lock. Transaction-scoped.
SET LOCAL lock_timeout = '5s';

-- ── 1. Columns + vocabulary — ONE statement, ONE validation scan ────────────
-- Nullable, no default: catalog-only on ~105k rows (no rewrite). The CHECK is
-- validated in the same pass while the lock is held — every row is NULL, so it
-- cannot fail. The detail is free text on purpose: a new collabBox series or a
-- new web store must not need a migration to be recorded.
ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS sale_source        text,
  ADD COLUMN IF NOT EXISTS sale_source_detail text,
  DROP CONSTRAINT IF EXISTS orders_sale_source_check,
  ADD CONSTRAINT orders_sale_source_check CHECK (
    sale_source IS NULL OR sale_source IN (
      'altercpa', 'web', 'elyon_crm', 'collabbox', 'affiliate', 'legacy'));

COMMENT ON COLUMN public.orders.sale_source IS
  'How the order ARRIVED (owner rule 2026-09-27): altercpa | web | elyon_crm | collabbox | affiliate | legacy. Set at INSERT by trg_orders_sale_source_fill via classify_sale_source(); write-once afterwards (trg_orders_sale_source_lock). An AlterCPA lead from a returning customer is still altercpa. NULL = not classified yet (pre-backfill row).';
COMMENT ON COLUMN public.orders.sale_source_detail IS
  'Sub-channel of sale_source: altercpa bridge|history · collabbox teleshop|social|leads|leads_out|<series> · elyon_crm disposition|prediction_list|direct · web <store> · affiliate partner · legacy <source_type>. Describes the row as it was BORN; write-once like sale_source.';

-- ── 2. isSyntheticProductName — SQL twin ────────────────────────────────────
-- Mirror of isSyntheticProductName in src/lib/utils.ts — KEEP THE TWO IN STEP
-- (supabase/functions/mex-reconcile/match.ts, scripts/lib/repair-kit.mjs and
-- scripts/verify-attribution.mjs carry copies as well). JS .trim() strips the
-- Unicode whitespace set spelled out below (tab..CR, space, NBSP, U+1680,
-- U+2000-200A, U+2028/9, U+202F, U+205F, U+3000, BOM); btrim() alone strips
-- only ASCII spaces and would disagree with the UI about a NBSP-padded name.
-- '—' is written as chr(8212): this repo has a history of mangled literals.
CREATE OR REPLACE FUNCTION public.is_synthetic_product_name(p_name text)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT s.t = '' OR s.t = chr(8212)
      OR s.t ~* '^(Cancelled|Trashed|No prior product on file)'
    FROM (SELECT regexp_replace(
                   coalesce(p_name, ''),
                   '^[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[\u0009-\u000d\u0020\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
                   '', 'g') AS t) s;
$fn$;

COMMENT ON FUNCTION public.is_synthetic_product_name(text) IS
  'SQL twin of isSyntheticProductName (src/lib/utils.ts): true for NULL/blank/— and for placeholder names starting Cancelled|Trashed|No prior product on file (case-insensitive, JS-trim semantics). Keep in step with the TS copies.';

-- ── 3. The ElyonCRM sub-channel ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.elyon_crm_sale_detail(
  p_prediction_list_id uuid,
  p_price              numeric,
  p_product_name       text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
           WHEN coalesce(p_price, 0) <= 0
             OR public.is_synthetic_product_name(p_product_name) THEN 'disposition'
           WHEN p_prediction_list_id IS NOT NULL                  THEN 'prediction_list'
           ELSE 'direct'
         END;
$fn$;

COMMENT ON FUNCTION public.elyon_crm_sale_detail(uuid, numeric, text) IS
  'ElyonCRM sub-channel: disposition (price 0/NULL or synthetic product — a call-outcome row, not a sale) > prediction_list (a sale while the customer sat on a list) > direct. Disposition is tested FIRST because the api stamps prediction_list_id on every status.';

-- ── 4. THE classifier ───────────────────────────────────────────────────────
-- Pure: same inputs, same answer, no table reads — which is what lets the
-- backfill (scripts/backfill-sale-source.mjs) and the insert trigger share it.
-- Returns {source, detail}; source is never NULL.
CREATE OR REPLACE FUNCTION public.classify_sale_source(
  p_source_type        text,
  p_external_source    text,
  p_external_order_id  text,
  p_prediction_list_id uuid,
  p_price              numeric,
  p_product_name       text)
RETURNS text[]
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $fn$
  SELECT CASE
    WHEN p_source_type = 'monadon_legacy'
      THEN ARRAY['legacy', 'monadon_legacy']
    -- Arrived through the AlterCPA intake: the live bridge, or the 2026-08
    -- history import that reused external_source = 'altercpa'.
    WHEN p_source_type = 'altercpa' OR p_external_source = 'altercpa'
      THEN ARRAY['altercpa', CASE WHEN p_source_type = 'altercpa' THEN 'bridge' ELSE 'history' END]
    WHEN p_source_type = 'affiliate'
      THEN ARRAY['affiliate', 'partner']
    WHEN p_source_type IN ('opencart', 'opencart_abandoned', 'inbound_lead')
      THEN ARRAY['web', p_source_type]
    WHEN p_external_source ILIKE 'naturatherapy%'
      THEN ARRAY['web', lower(p_external_source)]
    -- collabBox: the DocNumber IS the MEX tracking id and its middle segment
    -- names the sales channel (002-9102-119150/2025 → 9102 = teleshop).
    WHEN p_external_source = 'collabbox'
      THEN ARRAY['collabbox',
                 CASE split_part(coalesce(p_external_order_id, ''), '-', 2)
                   WHEN '9102' THEN 'teleshop'
                   WHEN '9100' THEN 'teleshop'
                   WHEN '9108' THEN 'social'
                   WHEN '9103' THEN 'leads_out'
                   WHEN '9110' THEN 'leads'
                   WHEN ''     THEN 'unknown'
                   ELSE split_part(p_external_order_id, '-', 2)
                 END]
    -- Created by our own agent: a cold call to an existing client.
    WHEN p_source_type IN ('manual', 'prediction_lead')
      THEN ARRAY['elyon_crm',
                 public.elyon_crm_sale_detail(p_prediction_list_id, p_price, p_product_name)]
    ELSE ARRAY['legacy', coalesce(nullif(p_source_type, ''), 'unknown')]
  END;
$fn$;

COMMENT ON FUNCTION public.classify_sale_source(text, text, text, uuid, numeric, text) IS
  'THE sale-source classifier (owner rule 2026-09-27: source = how the order ARRIVED, by intake path). Returns {source, detail}. Pure — the insert trigger and scripts/backfill-sale-source.mjs both call it. Rule order is documented in migration 20260935000000.';

-- ── 5. Fill at insert ───────────────────────────────────────────────────────
-- An explicit sale_source in the INSERT stands (an importer that knows
-- better). A duplicate inherits its ORIGINAL's source and detail: the api's
-- duplicate endpoint writes source_type = 'manual' on the copy, and 29 of the
-- 30 duplicates today are copies of AlterCPA leads — classifying the copy's
-- own columns would move them to ElyonCRM. If the original predates the
-- backfill (sale_source still NULL) its columns are classified instead.
--
-- A classification failure must never block an order from being created: the
-- handler leaves both columns NULL, which the backfill and the harness check
-- (C12: sale_source never NULL) will surface.
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_fill()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _o record;
  _c text[];
BEGIN
  IF NEW.sale_source IS NOT NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    IF NEW.duplicated_from IS NOT NULL THEN
      SELECT o.sale_source, o.sale_source_detail, o.source_type, o.external_source,
             o.external_order_id, o.prediction_list_id, o.price, o.product_name
        INTO _o
        FROM public.orders o
       WHERE o.id = NEW.duplicated_from;
      IF FOUND THEN
        IF _o.sale_source IS NOT NULL THEN
          NEW.sale_source        := _o.sale_source;
          NEW.sale_source_detail := _o.sale_source_detail;
        ELSE
          _c := public.classify_sale_source(_o.source_type, _o.external_source, _o.external_order_id,
                                            _o.prediction_list_id, _o.price, _o.product_name);
          NEW.sale_source        := _c[1];
          NEW.sale_source_detail := _c[2];
        END IF;
        RETURN NEW;
      END IF;
    END IF;

    _c := public.classify_sale_source(NEW.source_type, NEW.external_source, NEW.external_order_id,
                                      NEW.prediction_list_id, NEW.price, NEW.product_name);
    NEW.sale_source        := _c[1];
    NEW.sale_source_detail := _c[2];
  EXCEPTION WHEN OTHERS THEN
    NEW.sale_source        := NULL;
    NEW.sale_source_detail := NULL;
  END;
  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_sale_source_fill() IS
  'BEFORE INSERT on orders: fills sale_source/sale_source_detail via classify_sale_source() when the insert did not set them; a duplicate inherits its original''s. Never blocks an insert.';

REVOKE ALL ON FUNCTION public.tg_orders_sale_source_fill() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_sale_source_fill ON public.orders;
CREATE TRIGGER trg_orders_sale_source_fill
BEFORE INSERT ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.tg_orders_sale_source_fill();

-- ── 6. Write-once afterwards ────────────────────────────────────────────────
-- Column-scoped: only a write that NAMES sale_source or sale_source_detail
-- reaches this function, so ordinary order traffic never pays for it.
-- NULL → value is a fill (the backfill, or a repair) and is allowed; changing
-- or clearing a set value raises. The one deliberate override is
-- transaction-local:
--     SET LOCAL elyon.allow_source_change = 'on';
-- (scripts/backfill-sale-source.mjs does not need it: it only fills NULLs, in
-- session_replication_role = replica.)
CREATE OR REPLACE FUNCTION public.tg_orders_sale_source_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF coalesce(current_setting('elyon.allow_source_change', true), '') = 'on' THEN
    RETURN NEW;
  END IF;

  IF OLD.sale_source IS NOT NULL AND NEW.sale_source IS DISTINCT FROM OLD.sale_source THEN
    RAISE EXCEPTION 'orders.sale_source is write-once: order % arrived as %, refusing %',
                    coalesce(OLD.display_id, OLD.id::text), OLD.sale_source, coalesce(NEW.sale_source, 'NULL')
      USING ERRCODE = 'check_violation',
            HINT = 'Source = how the order ARRIVED (owner rule 2026-09-27). A deliberate correction runs in a transaction with SET LOCAL elyon.allow_source_change = ''on''.';
  END IF;

  IF OLD.sale_source_detail IS NOT NULL AND NEW.sale_source_detail IS DISTINCT FROM OLD.sale_source_detail THEN
    RAISE EXCEPTION 'orders.sale_source_detail is write-once: order % is %/%, refusing %',
                    coalesce(OLD.display_id, OLD.id::text), OLD.sale_source, OLD.sale_source_detail,
                    coalesce(NEW.sale_source_detail, 'NULL')
      USING ERRCODE = 'check_violation',
            HINT = 'A deliberate correction runs in a transaction with SET LOCAL elyon.allow_source_change = ''on''.';
  END IF;

  RETURN NEW;
END;
$fn$;

COMMENT ON FUNCTION public.tg_orders_sale_source_lock() IS
  'BEFORE UPDATE OF sale_source, sale_source_detail on orders: both are write-once (NULL → value allowed; any change of a set value raises) unless SET LOCAL elyon.allow_source_change = ''on''.';

REVOKE ALL ON FUNCTION public.tg_orders_sale_source_lock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_orders_sale_source_lock ON public.orders;
CREATE TRIGGER trg_orders_sale_source_lock
BEFORE UPDATE OF sale_source, sale_source_detail ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.tg_orders_sale_source_lock();

NOTIFY pgrst, 'reload schema';
