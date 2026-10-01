-- VAT PER PRODUCT, from Sigma (owner decision, Mile, 01.10.2026) — replaces the flat 18 % the CRM
-- used since 28.09.2026 (CLAUDE.md "VAT: 18 % — CONFIRMED by the owner on 28.09.2026" is withdrawn).
--
-- Evidence (docs/VAT.md, docs/vat/): Natura's own books — the Sigma ERP item master (Item.VatId:
-- 0 = 0 %, 1 = 18 %, 2 = 5 %, 3 = 10 %) — give every food supplement 5 % and cosmetics / gels /
-- creams / oils / devices / chia drinks 18 %; the 2026 sales invoices agree (7.124 lines at 5 %,
-- 158 at 18 % for the web-sold items, the МЕКС ПОШТА COD invoices included — e.g. MAGNESIUM
-- BISGLYCINATE, July 2026: 476,19 net + 23,81 VAT = 500,00).
--
--   products.vat_rate        0 | 0.05 | 0.10 | 0.18; NULL = UNCLASSIFIED (a new product, until an
--                            owner sets it). Every report taxes an unclassified line at 5 % (the core
--                            range) AND shows that amount apart as "unclassified" — never silent.
--   products.vat_source      how the rate was decided: sigma:crosswalk-VERIFIED|HIGH|MEDIUM (the S2
--                            product crosswalk → a Sigma item), sigma:manual (a wrong crosswalk link
--                            corrected by hand), sigma:by-name[+mixed] (the name names a Sigma item;
--                            +mixed = a bundle naming items of both rates keeps its main product's),
--                            rule:supplement-5 | rule:cosmetic-18 | rule:device-18 (no Sigma item —
--                            by product type), owner (set in the CRM by an owner, audited)
--   products.vat_sigma_code  the Sigma item (ItemID) the rate comes from
--   products.vat_sigma_name  its Sigma name
--   products.vat_evidence    the 2025–2026 sales-invoice lines of that item by year and rate
--                            ("2026@5.00: 77; mex@5.00: 10" — mex = the МЕКС ПОШТА COD invoices),
--                            or an owner's note
--   products.vat_set_by / vat_set_at   who / when (the backfill: NULL / this migration)
--
--   tg_products_vat_guard    the six columns change only through products_set_vat_rate() (the
--                            brand_line / kind pattern, 20260943001300 / 001400): a transaction-local
--                            gate, any other write is refused (42501)
--   products_set_vat_rate(ids, rate, actor, note)
--                            the ONLY writer: owners / admins through POST /api/products/vat-rate,
--                            one audit_log row (products.set_vat_rate) per call. rate NULL = back to
--                            unclassified. Service role only.
--   product_vat_rate(id)     the rate a report uses for a product: its own, else 0.05
--   the backfill             all 706 products of 01.10.2026 from docs/vat/crm_products_vat.json
--                            (generated: scripts/vat/gen-vat-backfill.mjs; a test checks the block
--                            against the JSON). Only rows still unclassified are written.
--   insights_profit()        VAT per LINE: each sale's value is already split over its lines by price
--                            weight (rv); VAT = Σ rv × r/(1+r), r = the line's product rate. New agg
--                            measures vt (VAT), vc (VAT of the costed part), vu (value at the default
--                            because unclassified), v00 / v05 / v10 / v18 (value by rate); per product
--                            vt, vr (rate), vd (defaulted). Every existing measure is unchanged.
--                            Body = the LIVE one (pg_get_functiondef 01.10.2026, = 20260942001900)
--                            with counted edits only (kc · ln1 · ln · lm · agg_l · agg · prod).
--   insights_profit_cache_sig()      + every product's vat_rate (a changed rate invalidates the cache)
--   insights_profit_cache_version()  4 → 5: no month cached with the flat 18 % is ever merged
--
-- Deploy order: this migration → the api edge function → the frontend (main). The api reads the new
-- measures when present and falls back to the default rate on an older body (labelled
-- vat.mode = 'flat_default'). Afterwards refresh the monthly cache (docs/VAT.md §Deploy).
-- Rollback: docs/VAT.md §Rollback (the previous bodies are in 20260942001900 / 20260942001000).

BEGIN;

SET LOCAL lock_timeout = '10s';

-- ── 0. drift guard: the bodies below were written against these live versions ─────────────────────
DO $drift$
DECLARE v_bad text;
BEGIN
  SELECT string_agg(e.sig, ', ' ORDER BY e.sig) INTO v_bad
  FROM (VALUES
    ('public.insights_profit(timestamp with time zone,timestamp with time zone,text,text,boolean)', '48ba64c02b7d06a6b13d5f740f7ac594', '506d7d42a8962f92e3c7e91604a173e0'),
    ('public.insights_profit_cache_sig()', '0dace55dbcb4b28060a86150da94e24a', 'a369c3deea5f96f32f3131bbe757ed17'),
    ('public.insights_profit_cache_version()', 'bdaf98d1f5bae3ccd6793b327800f41b', 'b4b2127a3fa9289a452ccf493c3a289f')
  ) e(sig, old_md5, new_md5)
  LEFT JOIN pg_proc p ON p.oid = to_regprocedure(e.sig)
  WHERE p.oid IS NULL OR md5(replace(p.prosrc, chr(13), '')) NOT IN (e.old_md5, e.new_md5);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'product VAT: % changed since this migration was written — re-emit it from the live body', v_bad;
  END IF;
END
$drift$;

-- ── 1. the columns ────────────────────────────────────────────────────────────────────────────────
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS vat_rate numeric(4,3),
  ADD COLUMN IF NOT EXISTS vat_source text,
  ADD COLUMN IF NOT EXISTS vat_sigma_code text,
  ADD COLUMN IF NOT EXISTS vat_sigma_name text,
  ADD COLUMN IF NOT EXISTS vat_evidence text,
  ADD COLUMN IF NOT EXISTS vat_set_by uuid,
  ADD COLUMN IF NOT EXISTS vat_set_at timestamptz;

ALTER TABLE public.products DROP CONSTRAINT IF EXISTS products_vat_rate_check;
ALTER TABLE public.products
  ADD CONSTRAINT products_vat_rate_check CHECK (vat_rate IS NULL OR vat_rate IN (0, 0.05, 0.10, 0.18));

COMMENT ON COLUMN public.products.vat_rate IS
  'The product''s Macedonian VAT rate as Natura''s books (Sigma Item.VatId) charge it: 0 | 0.05 | 0.10 | 0.18; NULL = unclassified (reports use 0.05 and show the amount apart). Written only by products_set_vat_rate() (audited). Owner decision 01.10.2026, migration 20260944000900, docs/VAT.md.';
COMMENT ON COLUMN public.products.vat_source IS
  'How vat_rate was decided: sigma:crosswalk-VERIFIED|HIGH|MEDIUM, sigma:manual, sigma:by-name[+mixed], rule:supplement-5|cosmetic-18|device-18, owner. docs/VAT.md.';
COMMENT ON COLUMN public.products.vat_sigma_code IS 'The Sigma item (ItemID) the rate comes from; NULL for a rule row.';
COMMENT ON COLUMN public.products.vat_sigma_name IS 'The Sigma item''s name.';
COMMENT ON COLUMN public.products.vat_evidence IS
  'The 2025–2026 Sigma sales-invoice lines of that item by year@rate ("mex@" = the МЕКС ПОШТА COD invoices), or an owner''s note.';
COMMENT ON COLUMN public.products.vat_set_by IS 'auth user id of the login that last set vat_rate (products_set_vat_rate); NULL = the 01.10.2026 backfill.';
COMMENT ON COLUMN public.products.vat_set_at IS 'When vat_rate was last set.';

-- ── 2. the guard: one audited writer ──────────────────────────────────────────────────────────────
-- products is writable by admins and managers straight through PostgREST ("… can manage products"),
-- so without this a rate could change with no audit row. products_set_vat_rate() opens the gate with
-- a transaction-local setting; the backfill below does the same deliberately.
CREATE OR REPLACE FUNCTION public.tg_products_vat_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $fn$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.vat_rate IS NULL AND NEW.vat_source IS NULL AND NEW.vat_sigma_code IS NULL AND NEW.vat_sigma_name IS NULL
       AND NEW.vat_evidence IS NULL AND NEW.vat_set_by IS NULL AND NEW.vat_set_at IS NULL THEN
      RETURN NEW;
    END IF;
  ELSIF NEW.vat_rate IS NOT DISTINCT FROM OLD.vat_rate
    AND NEW.vat_source IS NOT DISTINCT FROM OLD.vat_source
    AND NEW.vat_sigma_code IS NOT DISTINCT FROM OLD.vat_sigma_code
    AND NEW.vat_sigma_name IS NOT DISTINCT FROM OLD.vat_sigma_name
    AND NEW.vat_evidence IS NOT DISTINCT FROM OLD.vat_evidence
    AND NEW.vat_set_by IS NOT DISTINCT FROM OLD.vat_set_by
    AND NEW.vat_set_at IS NOT DISTINCT FROM OLD.vat_set_at THEN
    RETURN NEW;
  END IF;
  IF coalesce(current_setting('elyon.vat_rate_write', true), '') <> 'on' THEN
    RAISE EXCEPTION 'products.vat_rate is written only by products_set_vat_rate() (audited)'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS trg_products_vat_guard ON public.products;
CREATE TRIGGER trg_products_vat_guard
  BEFORE INSERT OR UPDATE OF vat_rate, vat_source, vat_sigma_code, vat_sigma_name, vat_evidence, vat_set_by, vat_set_at
  ON public.products
  FOR EACH ROW EXECUTE FUNCTION public.tg_products_vat_guard();

-- ── 3. the rate a report uses ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.product_vat_rate(p_product_id uuid)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
  SELECT coalesce((SELECT p.vat_rate FROM public.products p WHERE p.id = p_product_id), 0.05);
$fn$;

COMMENT ON FUNCTION public.product_vat_rate(uuid) IS
  'The VAT rate a report uses for a product: products.vat_rate, else 0.05 (the core range — food supplements) for an unclassified or unknown product. Callers must also report the unclassified amount. Migration 20260944000900.';

REVOKE ALL ON FUNCTION public.product_vat_rate(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.product_vat_rate(uuid) TO service_role;

-- ── 4. the writer ─────────────────────────────────────────────────────────────────────────────────
-- Sets (or, with p_rate NULL, clears) the rate of up to 1.000 products in one transaction and writes
-- ONE audit_log row (action products.set_vat_rate) with every change. Rows already at that rate are
-- left untouched and reported as unchanged; unknown ids come back as missing. The Sigma link
-- (vat_sigma_code / _name) is kept as information; vat_source becomes 'owner'; a note replaces the
-- evidence text (the invoice evidence stays in the audit row's `changes`).
CREATE OR REPLACE FUNCTION public.products_set_vat_rate(p_ids uuid[], p_rate numeric, p_actor uuid, p_note text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids uuid[];
  v_email text;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_changes jsonb;
  v_missing jsonb;
  v_updated int;
  v_found int;
BEGIN
  IF p_actor IS NULL THEN
    RAISE EXCEPTION 'actor is required' USING ERRCODE = '22023';
  END IF;
  IF p_rate IS NOT NULL AND p_rate NOT IN (0, 0.05, 0.10, 0.18) THEN
    RAISE EXCEPTION 'invalid VAT rate: % (0, 0.05, 0.10 or 0.18)', p_rate USING ERRCODE = '22023';
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RAISE EXCEPTION 'note is too long (max 500)' USING ERRCODE = '22023';
  END IF;
  SELECT coalesce(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(p_ids) AS i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN
    RAISE EXCEPTION 'no product ids' USING ERRCODE = '22023';
  END IF;
  IF cardinality(v_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 products per call' USING ERRCODE = '22023';
  END IF;

  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  SELECT count(*)::int INTO v_found FROM products WHERE id = ANY (v_ids);
  SELECT coalesce(jsonb_agg(i ORDER BY i), '[]'::jsonb) INTO v_missing
    FROM unnest(v_ids) AS i WHERE NOT EXISTS (SELECT 1 FROM products p WHERE p.id = i);

  PERFORM set_config('elyon.vat_rate_write', 'on', true);
  WITH prev AS (
    SELECT p.id, p.name, p.vat_rate AS from_rate, p.vat_source AS from_source, p.vat_evidence AS from_evidence
      FROM products p
     WHERE p.id = ANY (v_ids) AND p.vat_rate IS DISTINCT FROM p_rate
       FOR UPDATE
  ),
  upd AS (
    UPDATE products p
       SET vat_rate = p_rate,
           vat_source = CASE WHEN p_rate IS NULL THEN NULL ELSE 'owner' END,
           vat_evidence = coalesce(v_note, p.vat_evidence),
           vat_set_by = p_actor,
           vat_set_at = now()
      FROM prev
     WHERE p.id = prev.id
    RETURNING p.id
  )
  SELECT count(*)::int,
         coalesce(jsonb_agg(jsonb_build_object('id', prev.id, 'name', prev.name, 'from', prev.from_rate, 'to', p_rate,
                                               'from_source', prev.from_source, 'from_evidence', prev.from_evidence)
                            ORDER BY lower(prev.name), prev.id), '[]'::jsonb)
    INTO v_updated, v_changes
    FROM upd JOIN prev ON prev.id = upd.id;
  PERFORM set_config('elyon.vat_rate_write', 'off', true);

  IF v_updated > 0 THEN
    INSERT INTO audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (
      p_actor, v_email, 'products.set_vat_rate', 'products',
      CASE WHEN v_updated = 1 THEN v_changes -> 0 ->> 'id' END,
      coalesce(p_rate::text, 'unclassified'),
      jsonb_build_object(
        'rate', p_rate,
        'note', v_note,
        'requested', cardinality(v_ids),
        'updated', v_updated,
        'unchanged', v_found - v_updated,
        'missing', v_missing,
        'changes', v_changes
      )
    );
  END IF;

  RETURN jsonb_build_object(
    'rate', p_rate,
    'requested', cardinality(v_ids),
    'updated', v_updated,
    'unchanged', v_found - v_updated,
    'missing', v_missing,
    'changes', (SELECT coalesce(jsonb_agg(c.value - 'from_evidence' ORDER BY c.ord), '[]'::jsonb)
                  FROM jsonb_array_elements(v_changes) WITH ORDINALITY AS c(value, ord))
  );
END
$fn$;

COMMENT ON FUNCTION public.products_set_vat_rate(uuid[], numeric, uuid, text) IS
  'The only writer of products.vat_rate / vat_source / vat_sigma_* / vat_evidence / vat_set_*: sets p_rate (0 | 0.05 | 0.10 | 0.18; NULL = unclassified) on up to 1000 products, skips rows already at it, vat_source = owner, one audit_log row (products.set_vat_rate) with every change. Returns {rate, requested, updated, unchanged, missing, changes}. Feeds POST /api/products/vat-rate (owners). Migration 20260944000900.';

REVOKE ALL ON FUNCTION public.products_set_vat_rate(uuid[], numeric, uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.products_set_vat_rate(uuid[], numeric, uuid, text) TO service_role;

-- ── 5. the backfill: every product of 01.10.2026, from Sigma ──────────────────────────────────────
-- No audit_log row: audit_log.actor_id is NOT NULL and a migration has no human actor — the record
-- is this file, docs/vat/crm_products_vat.json and vat_source / vat_set_at on each row. Only rows
-- that are still unclassified are written; a product created after 01.10 stays NULL (unclassified).
-- products.updated_at is kept (bookkeeping write, update_updated_at_column honours the setting).
CREATE TEMP TABLE vat_backfill (
  id uuid PRIMARY KEY,
  rate numeric(4,3) NOT NULL,
  source text NOT NULL,
  sigma_code text,
  sigma_name text,
  evidence text
) ON COMMIT DROP;

-- >>> GENERATED by scripts/vat/gen-vat-backfill.mjs from docs/vat/crm_products_vat.json — do not edit by hand
-- 706 products
INSERT INTO pg_temp.vat_backfill (id, rate, source, sigma_code, sigma_name, evidence) VALUES
  ('009284ac-bb09-4740-8dfc-99ed67afa9c9'::uuid, 0.180, 'rule:cosmetic-18+mixed', NULL, NULL, NULL),
  ('00c8958e-f431-4842-ab6c-04f69f9d1adb'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005031', 'ELIXY DNEVNA & HYALURONIC +35  50 ml', '2025@18.00: 38; 2026@0.00: 1; 2026@18.00: 40; mex@0.00: 1; mex@18.00: 10'),
  ('00fe862e-e13e-489f-a14e-470aaae3ce88'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005014', 'ELIXY Хијалурон+авокадо масло', 'no 2025–2026 sales invoice'),
  ('0122bc7f-78dd-4914-8a45-c468aca54337'::uuid, 0.180, 'sigma:crosswalk-HIGH', '072290', 'МАЛ ГРИЛ ТОСТЕР', 'no 2025–2026 sales invoice'),
  ('014f1d2c-bd9e-402b-bc92-5b6047fcb3d3'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001318', '100% WHEY ВАНИЛА 2000 гр', '2025@5.00: 68; 2026@5.00: 99; mex@5.00: 4'),
  ('022ca17e-00af-48f2-91a2-d7cdca0c483b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001662', 'MELATONIN 1mg 120/1 tab', '2026@5.00: 48'),
  ('0241a855-0ec5-45ce-af34-de01d20e8c4b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('027d0145-c4b6-44cc-a400-ccae58f38873'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005018', 'ELIXY Масло од шипка 30 ml', '2025@18.00: 23; 2026@18.00: 16; mex@18.00: 6'),
  ('02c76e4c-6df1-415a-9610-d7ca8845d6f5'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001075', 'МАКА ЕКСТРАКТ 60/1 cps', '2025@5.00: 93; 2026@5.00: 99; mex@5.00: 8'),
  ('034ab0c8-eb0f-4e1c-be6c-772fd5ddbbd5'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('03ad93d6-5b28-4fbd-84a3-03629d3ab3d3'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('03e124ca-ba70-4cb9-8ff3-8a105b6297a7'::uuid, 0.050, 'sigma:by-name', '001333', 'SHILAJIT 60 cps', '2025@5.00: 36; 2026@5.00: 39; mex@5.00: 6'),
  ('042fd198-eeb6-4d05-922b-8089403a0f51'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000592', 'КУРКУМАКТИВ  250ml', '2025@5.00: 80; 2026@5.00: 38; mex@5.00: 11'),
  ('04fe60cd-5e81-41f1-a4ae-e3b2a9f94cad'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000889', 'ДИЕТ ШЕЈК Ванила 500g', '2025@5.00: 215; 2026@5.00: 149; mex@5.00: 11'),
  ('0537652b-43c7-4f15-8d9a-bd07e5322bf2'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('055c042f-1e6b-489f-a321-18cbc6dd34ec'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '2025@5.00: 34; 2026@5.00: 19; mex@5.00: 13'),
  ('0567ebad-600e-4c3b-9c05-10ecdeb3e8cb'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000040', 'СНАИЛ КРЕМА 100ml антиревматска туба', '2025@18.00: 233; 2026@18.00: 61; mex@18.00: 15'),
  ('06b8868d-be31-4adb-a582-b40594574195'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('07c2bff3-387a-46ec-b1aa-70dee96aa7c8'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000961', '100% WHEY PROTEIN-COKOLADO 1.5 kg', 'no 2025–2026 sales invoice'),
  ('07f086f7-39d8-40e3-a55b-f45d0e0f713c'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001333', 'SHILAJIT 60 cps', '2025@5.00: 36; 2026@5.00: 39; mex@5.00: 6'),
  ('080f3cca-96d6-4030-b4a9-989561ecf4a0'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000944', 'ВИТАМИН Б6  30tbl', '2025@5.00: 147; 2026@0.00: 2; 2026@5.00: 339; mex@0.00: 2; mex@5.00: 15'),
  ('08d8378d-7fb9-4470-8c20-5cdf7d2f29d9'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000602', 'ЦИНК 60tbl', 'no 2025–2026 sales invoice'),
  ('08e5b05d-a361-4774-90ba-73f8177e418f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001227', 'НУТРИ ШЕЈК-со вкус на ванила 500 гр.', '2025@5.00: 214; 2026@5.00: 210; mex@5.00: 15'),
  ('09083a2d-be56-49b7-8163-95e604743dbd'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001467', 'НУТРИ СУПА ДОМАТ 500 гр', '2026@5.00: 63; mex@5.00: 3'),
  ('0962a7cc-d547-46c8-92a0-38adc0f8c4cd'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000893', 'ДИЕТ ШЕЈК Јагода 500g', '2025@5.00: 225; 2026@5.00: 198; mex@5.00: 13'),
  ('09638ac1-a351-475f-9ddc-f74d6754eed3'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002810', 'Куркума гел', 'no 2025–2026 sales invoice'),
  ('09ad6c68-ef01-441e-85a8-aa0eba26f889'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001303', 'СЕТ Д-маноза 60/1+УРО протект 60/1', '2025@5.00: 24'),
  ('09d0794f-43f9-4fc9-b853-ef3d07168b4c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002008', 'Ноќна крема против брчки за зрела кожа', 'no 2025–2026 sales invoice'),
  ('0a67af01-ba33-42fc-949e-9fc5e60960e2'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000265', 'ПРОСТАТОЛ КОМПЛЕКС cps 30', '2025@5.00: 513; 2026@5.00: 329; mex@5.00: 19'),
  ('0a80a830-ddb3-48f6-b573-46aeeb1c5296'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005019', 'ELIXY Серум со витамин Ц', '2025@18.00: 69; 2026@18.00: 21; mex@18.00: 7'),
  ('0ab135cd-76c7-4f36-af48-79be5cb1eabe'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002374', 'Веногел 250мл', 'no 2025–2026 sales invoice'),
  ('0b38974a-ca7d-4892-b17c-e83a2bb5ce5c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001303', 'СЕТ Д-маноза 60/1+УРО протект 60/1', '2025@5.00: 24'),
  ('0b55e97d-8d3b-49f3-8c34-0b95701a0184'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000222', 'АЛОЕ ВЕРА ГЕЛ СО КАЛИНКА 1Л', 'no 2025–2026 sales invoice'),
  ('0b580055-8b76-4a0f-8149-acf6024f0c94'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('0b987872-fdca-4f7d-87d6-1dd703060ecd'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000797', 'Имуно буст ПОРТОКАЛ-АНАНАС 500ml', '2025@5.00: 155; 2026@5.00: 174; mex@5.00: 11'),
  ('0ba6c1aa-7400-4dea-9ac9-07196b01c492'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000583', 'ЧИА ТЕРАПИЈА со вит.Ц Диња 500ml', '2025@18.00: 140; 2026@18.00: 100; mex@18.00: 11'),
  ('0c6b656d-6b35-44e0-8ab4-5c5d98074f37'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001204', 'СЕТ КОЛАГЕН ПЕПТИД МАЛИНА 1+1', '2025@5.00: 265; 2026@5.00: 58'),
  ('0cdf4107-538c-4f25-94ac-c7c9095aefdc'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000564', 'АЛОЕ РОЈАЛ 250 ml.', '2025@5.00: 35; mex@5.00: 6'),
  ('0d3e23a1-d9ce-4f7b-bbd2-e0e3cb21fc47'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '005046', 'ELIXY КАПСУЛИ ЗА КОСА 60 cps', '2025@5.00: 53; 2026@5.00: 43; mex@5.00: 6'),
  ('0d8459a2-7a74-4997-a6d4-4abf773172c9'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000941', 'СЛЕЕП Мелатонин 30 tbl', '2025@5.00: 198; 2026@0.00: 2; 2026@5.00: 529; mex@0.00: 2; mex@5.00: 7'),
  ('0dd5f742-e048-4297-bb18-5d354388ea47'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('0de0bb0d-c9ff-45e5-aa35-494caf302cfc'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000503', 'БРОНХО ПРОТЕКТ 250ml', '2025@5.00: 392; 2026@5.00: 144; mex@5.00: 12'),
  ('0e1f99f4-590f-4578-be1b-2c2b972f382a'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('0ee4ff8a-b12e-44c5-84ca-7b26bb0373f2'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005009', 'ELIXY Масло од маслинка 30 ml', '2025@18.00: 18; 2026@18.00: 8; mex@18.00: 6'),
  ('0eee4f2f-f28a-4340-b930-28a8137c21e7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001026', 'ДР. СЛИМ 210 гр.', '2025@5.00: 29; 2026@5.00: 3; mex@5.00: 3'),
  ('0f6b402d-b313-4733-b52f-616b81e1bb3d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000955', 'Л-ГЛУТАМИН во прав 200 гр.', '2025@5.00: 134; 2026@5.00: 147; mex@5.00: 11'),
  ('0f6e5240-0e90-4b56-a18f-86e2b49b9969'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005034', 'МЕЛЕМ R&R 100 ml', '2025@18.00: 40; 2026@18.00: 15; mex@18.00: 15'),
  ('1004aa34-25d3-411c-ba58-cc69c5a44222'::uuid, 0.180, 'sigma:crosswalk-HIGH', '075536', 'МИКСЕР РОТИРАЧКИ', 'no 2025–2026 sales invoice'),
  ('1017ab0f-8a54-470f-bb6a-45e8392f5fb7'::uuid, 0.180, 'sigma:crosswalk-HIGH', '033239', 'МАШ.ЗА БРИЧЕЊЕ', 'no 2025–2026 sales invoice'),
  ('1029ce3e-7798-4615-bce5-1f787d7cfca6'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001173', 'АМИНО ЕНЕРЏИ БУСТ 500 мл', '2025@5.00: 53; 2026@5.00: 35; mex@5.00: 7'),
  ('10a7caaf-0fdc-4814-b9eb-fa0e7d09ff83'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001078', 'ХИАЛУРОН 5  90 гр (1+1)', '2025@5.00: 2'),
  ('1215c81a-36a2-4f70-b0b5-f318991cc70d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000619', 'Слим комплекс+ Слим фибер 1+1 гратис', '2025@5.00: 6'),
  ('13664a4a-d042-4664-b265-8eb09c1b1879'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '005037', 'ELIXY-hyaluronic acid-collagen&aloe vera', '2025@18.00: 5; 2026@18.00: 40; mex@18.00: 8'),
  ('1395475b-b4a4-41cf-92ba-118d3d9af794'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001540', 'HEMOROFIX BIONATURAL 30/1', '2026@0.00: 1; 2026@5.00: 8; mex@0.00: 1; mex@5.00: 3'),
  ('13a117b6-77c0-4cd5-8288-1217cae6519c'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001625', '100 %WHEY без вкус 400 гр', 'no 2025–2026 sales invoice'),
  ('13bd48e7-145c-4e3a-8f95-a60f1eccd350'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002006', 'Дневна крема против брчки', 'no 2025–2026 sales invoice'),
  ('13f0cd48-90b9-4caa-a6e2-ea779fd4d0d0'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001600', 'EISEN+B9+B12 250/1 tab', 'no 2025–2026 sales invoice'),
  ('13ff2f0a-2f67-48d1-a87c-b5154d1431ab'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('146a38e1-6d48-4b85-8263-02d3840d534b'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005043', 'ELIXY-Шампон Алое вера 500 мл.', '2025@18.00: 88; 2026@18.00: 47; mex@18.00: 6'),
  ('14b42fc6-0d81-48fe-9a0e-b575d00ed04f'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005032', 'ELIXY DNEVNA & HYALURONIC +45  50 ml', '2025@18.00: 44; 2026@0.00: 2; 2026@18.00: 54; mex@0.00: 2; mex@18.00: 12'),
  ('15736aff-ff11-422d-8c2b-a617d0a94151'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000113', 'СНАИЛ КОМПЛЕКС 30/1 сет (2+1)', '2025@5.00: 242; 2026@5.00: 107'),
  ('15eed2fb-1f78-4654-8c80-4e9ae89b3fde'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('16e09162-ff58-4939-8327-bedabee0b3b1'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000310', 'ПМС КОМПЛЕКС 30cps', 'no 2025–2026 sales invoice'),
  ('1702df10-a9aa-43ff-b92a-007090c9c325'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000126', 'КУРКУМИН ЕКСТРАКТ cps 30', '2025@5.00: 38; 2026@5.00: 2; mex@5.00: 9'),
  ('1740f1c2-c42c-4ffc-814b-50f6b3208f05'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000760', 'ХОЛЕСТОЛ КОМПЛЕКС СЕТ (2+1)', '2025@5.00: 65; 2026@5.00: 30'),
  ('17bce4dc-5e81-4979-b826-b6cd1274bcb0'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('17d87936-4c4a-4a13-92b2-2f21ff3b3f42'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('17e1f647-8091-4434-9fac-94ffc21c00d7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001291', 'CARDIOFIX BIONATURAL 30 cps', '2025@5.00: 1; 2026@0.00: 2; 2026@5.00: 12; mex@0.00: 2; mex@5.00: 4'),
  ('17f4e318-d6af-42c5-9746-f9606fbf59b9'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('180fad98-bbe4-477a-b2e0-a76d78f02d01'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('18a840d3-7629-4b8f-9275-f5e481b4a136'::uuid, 0.050, 'sigma:by-name', '001468', 'НУТРИ СУПА РАСТИТЕЛЕН МИКС 500 гр', '2026@5.00: 75; mex@5.00: 4'),
  ('18cee8e2-21de-4cc1-a9ea-e910c18f0a2f'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001298', 'ТУРМЕРИК 425мл  1+1 НЕУРО АКТИВ', '2025@5.00: 2; 2026@5.00: 2'),
  ('18f6fe44-1682-4494-a3e6-57312a8f9eac'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000889', 'ДИЕТ ШЕЈК Ванила 500g', '2025@5.00: 215; 2026@5.00: 149; mex@5.00: 11'),
  ('199b608e-be28-4248-a0d7-1fc24e3ecb36'::uuid, 0.180, 'sigma:by-name+mixed', '005006', 'ELIXY-Ноќен крем снаил 50ml', '2025@18.00: 79; 2026@18.00: 44; mex@18.00: 8'),
  ('19bc2c2c-e944-46f9-bcf8-a5ac29998de5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000552', 'БРОНХО ПРОТЕКТ 500ml (сет 2+2)', 'no 2025–2026 sales invoice'),
  ('19ecfaec-7cbf-4390-acbb-029ec8ff2c0e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('1a1016fd-6c55-45d8-82dd-eb4b78a79a08'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000271', 'САУ ПАЛМЕТТО (Saw Palmetto) 30 cps', '2025@5.00: 105; 2026@0.00: 1; 2026@5.00: 68; mex@0.00: 1; mex@5.00: 17'),
  ('1b228021-35f8-40ed-b0f7-bb6198afd8ba'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('1b5a1965-17b1-4c6c-a841-b21ba8d3e747'::uuid, 0.050, 'sigma:crosswalk-HIGH', '005036', 'Хеморо форте (2+1)+ Хеморо гел', '2025@18.00: 1; 2025@5.00: 55; 2026@5.00: 28'),
  ('1b6b6ecc-764a-47cd-8b07-ed3119d5b53f'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('1b8e586f-168c-4447-b826-5c180e09cdcd'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('1c03bb9e-3a80-4d16-8906-0063f8338c84'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001152', 'ВИТАМИН Д3 90 tbl', '2025@5.00: 153; 2026@5.00: 128; mex@5.00: 10'),
  ('1c0fc095-0cb2-44d6-84d0-1f63b5da5b58'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001660', 'VITAMIN B6 120/1 tab', '2026@5.00: 61'),
  ('1cbd1e9d-31db-4332-b398-4ed37ba3e394'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '002391', 'Ф-50 КРЕМА ЗА СОНЧАЊЕ ЛИЦЕ 50 мл.', 'no 2025–2026 sales invoice'),
  ('1d1e8a3c-d730-41cf-86bc-e565dbee142e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000315', 'АКАИ БЕРИ ЕКСТРАКТ 30 cps', '2025@5.00: 1; mex@5.00: 1'),
  ('1d64e89b-f187-4f91-b433-97022ecf6b8f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000090', 'АЛОЕ ВЕРА ГЕЛ-РЕСВЕРА.1Л-сет 2+1', '2025@5.00: 7'),
  ('1d927bd9-eac7-43c5-9a95-ab7d4b1f1369'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000488', 'АНДРОГРАФИС ЕКСТРАКТ 30cps', '2025@5.00: 1; mex@5.00: 1'),
  ('1e01b8be-e04d-460a-adb1-8adf96a348ef'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('1e476ceb-9edb-4b59-a325-ab7d5d96e8cd'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('1e754d30-7898-44ed-b729-198cc415907e'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('1e783606-31c8-4ead-8460-c83fa83956bc'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('1e9db2de-9b7b-4312-a28e-de0b169be316'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074368', 'ФЕН ЗА КОСА', 'no 2025–2026 sales invoice'),
  ('1edb0cfd-6b7c-4b8c-bee5-9b71623e39a7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('1f6cb0f6-7a2b-4994-9b73-87d07d66b8f4'::uuid, 0.180, 'sigma:by-name', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('1fbfc3a0-413a-4c59-b802-9c3b16009adc'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001438', 'OXI JET POWER 8 L', '2025@18.00: 25; 2026@18.00: 42; mex@18.00: 1'),
  ('205f121b-5838-49c8-a33c-aa6993aa35b9'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002330', 'Крем.за околу очи со смил 15мл', 'no 2025–2026 sales invoice'),
  ('20aa7e33-be8c-495b-a925-d34addf7e105'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001530', 'МЕЛАТОНИН 365/1 таб', '2026@5.00: 57; mex@5.00: 6'),
  ('20cce4d1-d191-4b32-92a9-616d8ca3d4f0'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('20dc61f2-8ab4-4fe0-b196-7e51d71c5d83'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000637', 'КУРКУМАКТИВ 500ml', '2025@5.00: 246; 2026@5.00: 264; mex@5.00: 18'),
  ('2189a913-2b23-40e4-b5c8-91063c8c8b4c'::uuid, 0.050, 'sigma:by-name+mixed', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('21cf5a21-fb6b-41e2-8eb9-8aa648195505'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001524', 'B6 180/1 tab BIONATURAL', '2026@0.00: 1; 2026@5.00: 7; mex@0.00: 1; mex@5.00: 2'),
  ('22299b37-eedb-4a91-b4d1-73938fc73e46'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000474', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л(сет 1+1)', 'no 2025–2026 sales invoice'),
  ('228a7094-983b-4854-9f71-fef80760bcb7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000309', 'БИТЕР МЕЛОН ЕКСТРАКТ 30 cps', '2025@5.00: 7; mex@5.00: 4'),
  ('2360a134-1183-4ec5-8baa-0b65e83cb87c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '048965', 'ТОСТЕР ЗА ЛЕПЧИЊА', 'no 2025–2026 sales invoice'),
  ('2376da90-8211-4115-919e-b64a33692918'::uuid, 0.050, 'sigma:by-name', '001293', 'NATURAL LAXATIVE 100% 90/1 cps', '2025@5.00: 52; 2026@5.00: 21; mex@5.00: 5'),
  ('24131855-afee-4caf-9075-d051a24c2782'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000949', 'АРТРО БЛУ ГЕЛ 200 МЛ', '2025@18.00: 82; 2026@0.00: 2; 2026@18.00: 29; mex@0.00: 2; mex@18.00: 16'),
  ('252a1dfe-836e-4eb2-a8f5-89ef060dca17'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000973', 'Спирулина во прав 100 гр', '2025@5.00: 1; mex@5.00: 1'),
  ('25362981-2bb5-44b2-8df1-07b5f51d686b'::uuid, 0.050, 'sigma:by-name+mixed', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('255f9368-e736-4e04-ab72-0299ba645b24'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000649', 'БРАИН ПРОТЕКТ 30cps-сет2+1', '2025@5.00: 65; 2026@5.00: 46'),
  ('262dcdc5-b018-4b82-8f08-985b882010a2'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001684', 'NIGHT BURN 200 gr', '2026@5.00: 9'),
  ('27114cf4-3689-4616-99ff-e30a814454d9'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000391', 'АЛОЕ ВЕРА-за надво.уптр.250ml.', 'no 2025–2026 sales invoice'),
  ('2840a614-20a4-4dcd-8df4-d9e8051e06db'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('287fb838-e897-4e3f-a249-15b0bf9ca693'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005017', 'ELIXY Масло од марула 30 ml', '2025@18.00: 13; 2026@18.00: 9; mex@18.00: 3'),
  ('2895bf92-40e1-412c-9a61-faf67f11a059'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000198', 'НОНИ ЕКСТРАКТ 0,5 Л', '2025@5.00: 15; 2026@5.00: 12; mex@5.00: 6'),
  ('29287e07-6367-43e5-a254-cde8d080346f'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('292d5e5e-1cb0-49d7-a724-9e2d07983bbe'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000752', 'ОМЕГА 3 КАПКИ 30ml', '2025@5.00: 8; mex@5.00: 4'),
  ('2949c82c-7f4c-4313-a3be-507d82bd7c08'::uuid, 0.180, 'rule:cosmetic-18+mixed', NULL, NULL, NULL),
  ('29522a67-b9e6-4766-bad5-08afacc1f240'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000121', 'РЕИШИ КАПСУЛИ cps 30', '2025@5.00: 15; 2026@5.00: 10; mex@5.00: 7'),
  ('29f1e3d4-aadf-4139-ad45-52bf642f7a2d'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('2a39c3cd-73a1-4f4b-9eef-4307e3b73d8d'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001155', 'КИДС МУЛТИВИТАМИНС  120 tbl', '2025@5.00: 32; 2026@5.00: 5; mex@5.00: 5'),
  ('2a5f7d3b-747d-4acf-b36d-f498cdf1be6e'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('2ab2e771-2b7f-47d9-86b7-f4a2c459002d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001317', 'PROSTA FIX BIONATURAL 30 cps', '2025@5.00: 2; 2026@0.00: 2; 2026@5.00: 12; mex@0.00: 2; mex@5.00: 6'),
  ('2ac41ea2-95d4-4106-a3b5-70eebb43cb01'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000166', 'НЕУРО АКТИВ 60 cps', '2025@5.00: 195; 2026@5.00: 168; mex@5.00: 13'),
  ('2adfb3b1-3b1c-4405-b611-e0acf85d6b00'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001630', 'VITAMIN D3+K2+BOR 180/1 tab', '2026@5.00: 121; mex@5.00: 3'),
  ('2b4391b5-88d4-409e-bfc2-2fca5e1df747'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001462', 'БРОНХО ПРОТЕКТ ФОРТЕ 500 мл', '2026@5.00: 66; mex@5.00: 3'),
  ('2bc7aded-35d9-49ed-8972-b71a3548b6d3'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('2c5a4d59-eda2-42e6-921e-97010a10180d'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000637', 'КУРКУМАКТИВ 500ml', '2025@5.00: 246; 2026@5.00: 264; mex@5.00: 18'),
  ('2c793617-610a-4c87-b915-50cb2babcd9e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000265', 'ПРОСТАТОЛ КОМПЛЕКС cps 30', '2025@5.00: 513; 2026@5.00: 329; mex@5.00: 19'),
  ('2cc5d431-6210-4037-af6f-354d40e44d0b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000528', 'БРОНХО ПРОТЕКТ 500ml (сет 2+1)', '2025@5.00: 261; 2026@5.00: 108'),
  ('2cdadfb6-d556-4dcb-8a4c-0f4f39bb1021'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002368', 'Гавез гел 250мл', 'no 2025–2026 sales invoice'),
  ('2d8b0b05-9107-4dbf-a688-13b229b2b27c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001183', 'A4 60 cps', 'no 2025–2026 sales invoice'),
  ('2d950e9d-6acd-45fe-ad6f-9f56ef99acfc'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001150', 'ОСТЕО ФИКС 180 tab', '2025@5.00: 54; 2026@5.00: 10; mex@5.00: 4'),
  ('2da1de15-e62d-45cb-a795-741065b76161'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001061', '100% WHEY ЧОКОЛАДО 1.2 КГ', '2025@5.00: 101; 2026@5.00: 8; mex@5.00: 8'),
  ('2da4e74f-5336-4c69-a95a-fda03bc3a8ba'::uuid, 0.180, 'sigma:by-name', '005030', 'ELIXY-ТЕРМО ГЕЛ 200ml+КРИО ГЕЛ 200ml', '2025@18.00: 64; 2026@18.00: 13; mex@18.00: 5'),
  ('2dcaeaa8-d04b-42a5-b622-60105e8a7d59'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002339', 'Златно масло од смил 15мл', 'no 2025–2026 sales invoice'),
  ('2ebe6342-79e8-4a51-8387-7731c9d0fd3a'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('2edc76db-48fb-4820-8da9-04ce52cf66db'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000271', 'САУ ПАЛМЕТТО (Saw Palmetto) 30 cps', '2025@5.00: 105; 2026@0.00: 1; 2026@5.00: 68; mex@0.00: 1; mex@5.00: 17'),
  ('2ef640bd-7722-4abf-a60f-1daae8e5bcdd'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000742', 'БРАИН ПРОТЕКТ 30+30cps', '2025@5.00: 99; 2026@5.00: 25; mex@5.00: 2'),
  ('2ef6d4b0-095f-4771-9cf6-88969ae7410d'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000998', '100% WHEY PROTEIN-VANILA 1.5 kg', '2026@5.00: 1; mex@5.00: 1'),
  ('30141f7d-f252-4934-a063-57c5004f42d1'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001076', 'ТРИБУЛУС ТЕРЕСТРИС 60/1 cps', '2025@5.00: 113; 2026@5.00: 70; mex@5.00: 11'),
  ('30a5ed85-1bff-4830-9cb0-dab77b0c337f'::uuid, 0.180, 'sigma:crosswalk-HIGH', '054390', 'ТЕЛЕВИЗОР', 'no 2025–2026 sales invoice'),
  ('30add053-f69a-4903-954d-50645540bdaa'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005019', 'ELIXY Серум со витамин Ц', '2025@18.00: 69; 2026@18.00: 21; mex@18.00: 7'),
  ('30b787a2-cad2-4d4f-a951-5948de6eb452'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('30f153d5-93b6-4fca-80ec-a871c81a0182'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000565', 'ГАСТРО АЛОЕ 500ml', '2025@5.00: 375; 2026@5.00: 160; mex@5.00: 18'),
  ('310309b6-b363-478e-bc1d-8154637ce8c8'::uuid, 0.050, 'sigma:by-name', '001214', 'ГЛУКАТОЛ 180/1 cps', '2025@5.00: 41; 2026@5.00: 15; mex@5.00: 5'),
  ('318077bc-32bc-4e9b-aee6-33ddcfe71380'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001159', 'САМБУКУС сируп 250 мл', '2025@5.00: 102; 2026@5.00: 56; mex@5.00: 15'),
  ('3210b3ba-c1e3-49f5-a02d-fd58b3fadcb7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001133', 'Гумени бонбони Вит Д3  30/1', '2026@5.00: 103; mex@5.00: 2'),
  ('3231056c-16ea-453f-92ee-82431a92d770'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005006', 'ELIXY-Ноќен крем снаил 50ml', '2025@18.00: 79; 2026@18.00: 44; mex@18.00: 8'),
  ('324b60bd-05f2-4446-9a77-d47b52f49e97'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000166', 'НЕУРО АКТИВ 60 cps', '2025@5.00: 195; 2026@5.00: 168; mex@5.00: 13'),
  ('32b09c49-4741-4664-967f-4a9ae34ad2be'::uuid, 0.050, 'sigma:crosswalk-HIGH', '002447', 'Протеин.шејк во прав јагода 500 гр', 'no 2025–2026 sales invoice'),
  ('33c1d3a7-7711-416d-99e0-218be326ef05'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000447', 'ХЕПАТОЛ ФОРТЕ 30 cps (сет 2+2)', 'no 2025–2026 sales invoice'),
  ('340622dc-77e0-446e-88c4-33a5be732c8a'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005033', 'ELIXY DNEVNA & HYALURONIC +55  50 ml', '2025@18.00: 38; 2026@0.00: 2; 2026@18.00: 51; mex@0.00: 2; mex@18.00: 8'),
  ('344a7b7a-9c41-4e75-9d69-ea818f527e3e'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('34e43121-df01-4e65-940a-2dc66efb0d24'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('35a1cda5-23ac-49af-8c74-5e104f87954c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001200', 'ФЕММЕ 7 60 cps', '2025@5.00: 157; 2026@0.00: 1; 2026@5.00: 108; mex@0.00: 1; mex@5.00: 16'),
  ('373d6789-92b9-4e8a-8bf9-8ec2e6c9e174'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000898', '100% WHEY PROTEIN-VANILA 1kg', '2026@5.00: 1'),
  ('373f6352-5f2f-4226-8050-6a18c5b8e09c'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005010', 'ELIXY Масло од авокадо 30 ml', '2025@18.00: 36; 2026@18.00: 11; mex@18.00: 7'),
  ('375aece7-e3f2-4587-ac22-1c1d90954d8f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('37d15cbb-40ac-4bcc-aab7-f3bce24d82dd'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000577', 'ВИТАМИН Ц 1Л СЕТ (2+1)', 'no 2025–2026 sales invoice'),
  ('3825524b-5421-460a-9853-73523d61c2b6'::uuid, 0.180, 'sigma:by-name', '005006', 'ELIXY-Ноќен крем снаил 50ml', '2025@18.00: 79; 2026@18.00: 44; mex@18.00: 8'),
  ('3894faab-8496-4d2a-8ed5-6bf683554881'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001287', 'SLIM RUSH 30 cps', 'no 2025–2026 sales invoice'),
  ('3966fa17-925e-43f4-b6dd-1361bc665e14'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('39a017e6-ef0c-45ca-83de-b5131aabd670'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074295', 'Титаниум тава 25 см', 'no 2025–2026 sales invoice'),
  ('3a754b34-11cd-4fba-8913-6acb3b6ccf76'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000502', 'ВЕНОГЕЛ гел 100ml', '2025@18.00: 73; 2026@18.00: 27; mex@18.00: 14'),
  ('3ab2c622-0c32-4413-85da-6ebfffbdef71'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002056', 'ШАМП.ПРОТИВ ОПАЃАЊЕ 250мл', 'no 2025–2026 sales invoice'),
  ('3ac70fb9-62da-42d2-997b-ea92e989efe5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001662', 'MELATONIN 1mg 120/1 tab', '2026@5.00: 48'),
  ('3acbd739-2ee6-4d63-92b0-e8cb47a83d73'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001084', 'ПАРА ДЕТОКС 30cps (2+1)', '2025@5.00: 18; 2026@5.00: 2'),
  ('3c18bf6b-ac05-43f0-a237-fd728ceca789'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001468', 'НУТРИ СУПА РАСТИТЕЛЕН МИКС 500 гр', '2026@5.00: 75; mex@5.00: 4'),
  ('3c7bc799-b774-4708-9cef-6053d2dcec15'::uuid, 0.050, 'sigma:by-name', '001318', '100% WHEY ВАНИЛА 2000 гр', '2025@5.00: 68; 2026@5.00: 99; mex@5.00: 4'),
  ('3d2a3fb0-e0db-471f-911c-887705bc5cd8'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000528', 'БРОНХО ПРОТЕКТ 500ml (сет 2+1)', '2025@5.00: 261; 2026@5.00: 108'),
  ('3d8238e0-9f39-40e9-b05f-1baf235ecae1'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001339', 'СЕТ ЛАКСАТИВ', '2026@5.00: 4'),
  ('3e09c75d-a42f-41f2-bc1c-e0f0ef4e8d33'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001006', 'Снаил комплекс 30+30 cps+Глукоз.Сулфат', '2025@5.00: 364; 2026@5.00: 99'),
  ('3e5e29b3-1921-4dbc-8ad6-4f312a560e60'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '001461', 'МАШИНКА ЗА НЕС', '2026@18.00: 1'),
  ('3f2f28cf-8d66-4c52-91fa-65b00608072d'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('3ff3e198-94c7-4f05-8eb9-d723daeedaa3'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('402c7159-20dc-480c-931b-0a9def19216a'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002343', 'Витамин Ц серум 30мл', 'no 2025–2026 sales invoice'),
  ('40bc32d1-6b42-4f12-95b9-a078ad855953'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001427', 'МАЧА со КОЛАГЕН 175 гр', '2025@5.00: 33; 2026@5.00: 188; mex@5.00: 3'),
  ('40edd278-412d-4cc7-9d91-f528b3d354ae'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000461', 'ДИАБЕТОЛ ФОРТЕ 30cps (сет 2+1)', '2025@5.00: 93; 2026@5.00: 54'),
  ('40f401f0-b00d-4d09-a2f9-e119a2ab645a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000893', 'ДИЕТ ШЕЈК Јагода 500g', '2025@5.00: 225; 2026@5.00: 198; mex@5.00: 13'),
  ('41c7a0bd-7b61-4319-a015-0a2831adb2a0'::uuid, 0.180, 'sigma:by-name', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('41dcd909-4d23-47d5-869b-3d8c266b72a8'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001225', 'ДР.СЛИМ 90 цпс', '2025@5.00: 88; 2026@0.00: 1; 2026@5.00: 77; mex@0.00: 1; mex@5.00: 10'),
  ('427cfd06-9661-4235-a563-33d15f19ed6d'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('428039c1-1ec6-412b-9ec2-8ad230e3d09b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000891', 'ДИЕТ ШЕЈК чоколадо 500 g', '2025@5.00: 225; 2026@5.00: 166; mex@5.00: 11'),
  ('432bde3d-2ed5-4127-9747-3c6ea64f6e41'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001654', 'ZINC 120/1 tab fizicki', '2026@5.00: 4; mex@5.00: 2'),
  ('4364ddc3-c6a4-48de-ace8-ea623d71f5da'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000194', 'КУРКУМИН ЛИКВИД 0,5  Л', 'no 2025–2026 sales invoice'),
  ('43df7852-a7f3-46f3-807c-bbce7260bc39'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001132', 'Гумени бонбони Мелатонин 30/1', '2025@5.00: 26; 2026@5.00: 127; mex@5.00: 6'),
  ('4452378b-a942-4f36-a438-96cee731bb62'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000022', 'СНАИЛ РЕПАИР КРЕМА ЗА ЛИЦЕ 50ml', 'no 2025–2026 sales invoice'),
  ('44a39b36-a984-4f10-8ded-64a30c36dfc6'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002219', 'ГЕЛ ЗА ФИКС.НА ВЕГИ BROW', 'no 2025–2026 sales invoice'),
  ('44b4eaad-24dd-43d2-867c-4f1ff9c44932'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('44b609b1-d433-4fb5-9f3a-055f3604d71f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001087', '100% WHEY ЧОКОЛАДО 500 гр', '2025@5.00: 287; 2026@5.00: 142; mex@5.00: 8'),
  ('456139ed-0151-479b-9680-00b090075db0'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000594', 'УРО ПРОТЕКТ 30 cps', '2025@5.00: 78; 2026@5.00: 73; mex@5.00: 15'),
  ('45fbadb2-aaf3-4f50-9ecb-31cf52055006'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('469da6c2-9649-46ec-8813-db18d16beed9'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('46af0e21-1941-41cf-9728-b24c0615081f'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000923', 'Л-КАРНИТИН  60 cps', '2025@5.00: 125; 2026@5.00: 59; mex@5.00: 13'),
  ('472912aa-5d0b-4d65-a303-ec3bf7fead59'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005035', 'ХЕМОРО ГЕЛ 100 мл', '2025@18.00: 98; 2026@18.00: 64; mex@18.00: 12'),
  ('47ecce49-6c65-45f7-ac05-1e47bfadd3a0'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('47eeab25-3b9e-4a74-b75c-eb73aec390ae'::uuid, 0.050, 'sigma:crosswalk-HIGH', '002446', 'Протеин.шејк во прав/вани.и цимет 500 гр', 'no 2025–2026 sales invoice'),
  ('47f75868-497e-4262-afd5-d10d88155ba3'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001439', 'ANTI CHOKING DIVICE MASK', '2026@18.00: 39'),
  ('4820aa2c-fea5-4f6e-9395-b8bd4fc50a7a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000536', 'ГАСТРО ПРОТЕКТ 250 ml', '2025@5.00: 16; 2026@5.00: 2; mex@5.00: 3'),
  ('48f3334a-d36b-4257-815f-15a7cf76fb9d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000740', 'ПРОСТАТОЛ КОМПЛЕКС  30+30cps', 'no 2025–2026 sales invoice'),
  ('4945d3e6-0e47-48a8-960e-1bd296a75eb4'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('4a64e9a9-c5f0-4556-9937-744efc7cd217'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000595', 'Гастро протект+Гастро Алое 2+2', '2025@5.00: 85; 2026@5.00: 20'),
  ('4a8748bc-f7eb-4815-bf96-24365c379580'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('4b305ae3-3f12-4742-8ebd-dbf52d30b6c6'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005013', 'ELIXY-Серум снаил+јојоба', 'no 2025–2026 sales invoice'),
  ('4bc428ee-bfc1-4ffa-a8f6-83b449a1a495'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000940', 'ЦИНК 30 tbl', '2025@5.00: 221; 2026@0.00: 2; 2026@5.00: 440; mex@0.00: 2; mex@5.00: 15'),
  ('4c08d0a6-f345-4539-835c-f9978ee8c862'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001405', 'HULK - Bulking Combo', '2025@5.00: 23'),
  ('4c15f7f7-7eaf-4112-8e47-53d3e2468ad3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001537', 'LIVERFIX BIONATURAL 30/1 cps', '2026@0.00: 1; 2026@5.00: 5; mex@5.00: 1'),
  ('4c8d833f-7db5-4809-966c-98abdbaa00e2'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001339', 'СЕТ ЛАКСАТИВ', '2026@5.00: 4'),
  ('4cb93130-876c-4a79-975e-15930be401d4'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000974', 'МАКС БРЕИН 200 гр', '2025@5.00: 55; 2026@5.00: 3; mex@5.00: 11'),
  ('4cff97e4-4e40-4efe-a729-da4e56ddc056'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001445', 'NMN 60/1 cps', '2026@5.00: 40; mex@5.00: 1'),
  ('4d720da7-d826-4771-915d-0c7aaa8ed194'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000636', 'БРАИН АКТИВ 30cps', '2025@5.00: 183; 2026@5.00: 139; mex@5.00: 19'),
  ('4d95e078-06d5-45c5-9d9e-ee643a0d651a'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('4dff694e-1686-4f27-b09b-4d944e6de2b1'::uuid, 0.180, 'sigma:crosswalk-HIGH', '034939', 'ПЕГЛА НА ПАРЕА', 'no 2025–2026 sales invoice'),
  ('4e835863-ddd5-4767-b189-4591d662fd5a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001691', 'Dr Becker ProstaCare 20/1 cps', 'no 2025–2026 sales invoice'),
  ('4ecbf110-f189-458c-b236-6eff403c1ccf'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000742', 'БРАИН ПРОТЕКТ 30+30cps', '2025@5.00: 99; 2026@5.00: 25; mex@5.00: 2'),
  ('4f30d74c-c348-4a0e-a97c-c1fca809f973'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005031', 'ELIXY DNEVNA & HYALURONIC +35  50 ml', '2025@18.00: 38; 2026@0.00: 1; 2026@18.00: 40; mex@0.00: 1; mex@18.00: 10'),
  ('4fb7ee97-8552-4e28-8870-afb351eef6c3'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5012b119-5f01-4bc5-8a85-98f1aeab1413'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('503773a2-d294-459f-8ac1-f5be7480a39b'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000893', 'ДИЕТ ШЕЈК Јагода 500g', '2025@5.00: 225; 2026@5.00: 198; mex@5.00: 13'),
  ('50482997-a856-4ba6-ab14-073bbd6c377b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000757', 'ХОЛЕСТОЛ КОМПЛЕКС 30 cps', '2025@5.00: 41; 2026@5.00: 28; mex@5.00: 12'),
  ('5059ba58-628c-4779-ac0a-275c51474cfd'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('51d6586d-42ad-41ef-bde2-710e1f6c4e28'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000119', 'КОЛАГЕН ПЕПТИДЕС  ВАНИЛА  200 ГР 1+1', '2025@5.00: 212; 2026@5.00: 48'),
  ('51f1258b-be25-4556-9c78-2511d32e0b7e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000611', 'СНАИЛ КОМПЛЕКС сет 2+2', 'no 2025–2026 sales invoice'),
  ('52fc3fd3-67f7-4443-a4b4-9993de796315'::uuid, 0.180, 'sigma:crosswalk-HIGH', '080001', 'ШЕЈКЕР', '2025@18.00: 1'),
  ('53177ffb-5852-4066-98b8-1174b49ba816'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('5341c90e-2cbb-418d-a6e8-ed22667b92ee'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002388', '4D ГОЛД СЕРУМ ЗА СЛАБЕЕЊЕ 250 мл', 'no 2025–2026 sales invoice'),
  ('539d21d1-aae0-46ef-8963-dda59ac6d150'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000033', 'ВИТАМИН Ц ЗА ВОЗРАСНИ 1Л', 'no 2025–2026 sales invoice'),
  ('53c2eeed-e036-497c-b75b-1dc145a0d566'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000209', 'ПУЛМО КОМПЛЕКС cps 30', '2025@5.00: 15; mex@5.00: 8'),
  ('540d532d-fdda-4d35-9fac-cd7bded5a639'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001566', 'ИМОРТЕЛЛЕ КРЕМ 50 мл', '2026@18.00: 20; mex@18.00: 1'),
  ('546733a1-5f79-4260-9f6c-d0052c7a41bc'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('54a6f9eb-1050-458f-98d5-df4a23a3c93c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001214', 'ГЛУКАТОЛ 180/1 cps', '2025@5.00: 41; 2026@5.00: 15; mex@5.00: 5'),
  ('54ee17b2-b88e-4f6d-bcdf-778560d9a4ad'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001529', 'ZINC  365 tbl', '2026@5.00: 73; mex@5.00: 5'),
  ('5575fef9-e4cc-4913-83c2-3bca47f61cb6'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('557863aa-a95c-4cfc-90c1-9632362bc41e'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002242', 'БРОНЗЕР ALL Y.908 Bronze Bay', 'no 2025–2026 sales invoice'),
  ('56299955-d23a-4d07-acfb-d6002945a0db'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001575', 'MAGNESIUM +ZINC+B complex 120/1tab', '2026@5.00: 159; mex@5.00: 5'),
  ('56d9d9aa-e7dc-468d-8518-6729145cf42b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000092', 'СЛИМ КОМПЛЕКС (сет2+1)', 'no 2025–2026 sales invoice'),
  ('56ee587f-2465-45c0-ae00-8543107fa977'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('578b42d3-c182-48fc-a43f-e0e66749f61f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001573', 'MAGNESIUM+ B6 150/1 tab', '2026@5.00: 121; mex@5.00: 2'),
  ('58058e98-07b8-40d7-af89-cd47d79e0804'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001318', '100% WHEY ВАНИЛА 2000 гр', '2025@5.00: 68; 2026@5.00: 99; mex@5.00: 4'),
  ('582dfc99-c936-4084-a02c-ad56b08fefbc'::uuid, 0.180, 'sigma:crosswalk-HIGH', '073507', 'СТАПЧЕСТ БЛЕНДЕР', 'no 2025–2026 sales invoice'),
  ('585c93a4-3a4e-4f1f-9458-06e8bcc73704'::uuid, 0.180, 'sigma:by-name', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('58a3e544-6db2-41d9-92d3-212944c86fb1'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('590500e2-9587-45a2-a88f-e89d9369c3fb'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001260', 'Глукатол 1+Билбери 60/1- 1+ Цинк 30/1-1', '2025@5.00: 3'),
  ('5957bc0d-825e-41fc-9087-02b03b5fab07'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001087', '100% WHEY ЧОКОЛАДО 500 гр', '2025@5.00: 287; 2026@5.00: 142; mex@5.00: 8'),
  ('59689803-b84b-4869-b8b5-5a65d6572057'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000542', 'МЕНОПАУЗА КОМПЛЕКС 30cps', 'no 2025–2026 sales invoice'),
  ('5abfa4da-9983-4a8d-a694-c19142b40b6c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001185', 'Сет Турмерик 2+1 Неуроактив', '2025@5.00: 63'),
  ('5b174cc4-4d40-4f31-ab83-d3dff486015c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('5b481426-d810-4d76-b8de-ea8af1efbbca'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001156', 'ЛИВЕР ДЕТОКС  90/1 cps', '2025@5.00: 121; 2026@5.00: 56; mex@5.00: 13'),
  ('5b9a2f41-4cad-4249-af96-cc68e35fa365'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5ba7d601-06b0-451d-9be4-d3956d413db5'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5bece61e-b74c-4bbc-a139-726981ecde5f'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002329', 'Матирачки флуид со смил 50мл', 'no 2025–2026 sales invoice'),
  ('5c0736b5-b4b6-4d2f-9bba-61d376a6c7eb'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5c445088-0d6e-4289-a9cc-13abeddfc287'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000940', 'ЦИНК 30 tbl', '2025@5.00: 221; 2026@0.00: 2; 2026@5.00: 440; mex@0.00: 2; mex@5.00: 15'),
  ('5ce5150e-4f75-475f-be43-2fe12cf43283'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5ce7ab08-0eaa-41fc-9be8-171b6cf415b7'::uuid, 0.180, 'sigma:crosswalk-HIGH', '075903', 'ФИГАРО', 'no 2025–2026 sales invoice'),
  ('5cf5c9cf-d038-4d94-bded-f19c56147de2'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5cf81fcc-07cd-43ee-862a-6521f713f677'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002040', 'ДНЕВНА И НОЌНА КРЕМА 50 мл', 'no 2025–2026 sales invoice'),
  ('5d17c4d6-dd1f-41f1-8707-2d4cd4b85d9b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000898', '100% WHEY PROTEIN-VANILA 1kg', '2026@5.00: 1'),
  ('5d6cafe1-0540-495c-9146-6eaed49dec38'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001134', 'Гумени бонбони Ашваганда 30/1', '2025@5.00: 10; 2026@5.00: 154; mex@5.00: 4'),
  ('5d87780a-9a0d-495f-b3d1-3b9dabb30e81'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '005027', 'ТЕРМО ГЕЛ 290ml+КРИО ГЕЛ 290ml', '2025@18.00: 2; 2026@18.00: 2'),
  ('5deb3d2c-fe2f-4e96-bf21-3d7669f591fb'::uuid, 0.180, 'sigma:by-name', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('5ea1f80d-bb46-4efa-9e25-f94f2ee25c34'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5ec751f6-0b4d-44b6-affa-29904763b945'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('5ec99f98-fe89-4000-9bd8-49d0da60f7b6'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('6021ef0b-ca7e-47b3-a01a-a16e4414b8e2'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001539', 'NEUROFIX BIONATURAL 30/1', '2026@0.00: 2; 2026@5.00: 10; mex@0.00: 2; mex@5.00: 3'),
  ('604ab890-8d89-4027-9956-946e87f1aea7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '2025@5.00: 34; 2026@5.00: 19; mex@5.00: 13'),
  ('605b5017-afed-4c3d-ac1a-9ff56e5cee7c'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000319', 'АЛОЕ РОЈАЛ 0,5 Л', '2025@5.00: 2; mex@5.00: 2'),
  ('60bb773c-c5ea-45a0-89a4-40a6e29adb06'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('61774769-8c1f-44d8-804c-ab2a41a1c526'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000552', 'БРОНХО ПРОТЕКТ 500ml (сет 2+2)', 'no 2025–2026 sales invoice'),
  ('6192e30a-2f1a-4e68-b830-aa2083a8fe80'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('622e1b33-c225-46b9-bd34-76fa8ca1e2cd'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001529', 'ZINC  365 tbl', '2026@5.00: 73; mex@5.00: 5'),
  ('62690050-795a-467d-8057-916b16bee383'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005032', 'ELIXY DNEVNA & HYALURONIC +45  50 ml', '2025@18.00: 44; 2026@0.00: 2; 2026@18.00: 54; mex@0.00: 2; mex@18.00: 12'),
  ('628251f2-157f-41c5-9df3-ac43017da1d2'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('631e029a-a1c8-4d27-a750-132891d4b837'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('638a0de0-c2b9-453a-ae1c-bf4621873e2f'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002789', 'Серум за лице', 'no 2025–2026 sales invoice'),
  ('63905403-4266-46a5-a75b-b4b5cfb15fce'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('63c76b2c-d32b-421c-b1d0-c5a2897e9021'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074368', 'ФЕН ЗА КОСА', 'no 2025–2026 sales invoice'),
  ('6455af36-3aa4-444b-bb67-f0e302e4e60a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001110', 'ВИТАМИН Д3 180 tbl', '2025@5.00: 37; 2026@5.00: 3; mex@5.00: 5'),
  ('647102ff-f838-4648-b4a4-e13a8808aa0b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '050420', 'КУЈИНСКА ВАГА', 'no 2025–2026 sales invoice'),
  ('6481cf64-0285-4715-9b9c-9bb47e81f65c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002051', 'БИОАКТИВ.ШАМП.-ЧИЧАК 150мл', 'no 2025–2026 sales invoice'),
  ('648bf301-da17-449a-9c1f-ee2415e054c6'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000611', 'СНАИЛ КОМПЛЕКС сет 2+2', 'no 2025–2026 sales invoice'),
  ('649240a9-f4c3-47a5-8961-34b8b211ff54'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000893', 'ДИЕТ ШЕЈК Јагода 500g', '2025@5.00: 225; 2026@5.00: 198; mex@5.00: 13'),
  ('66170d45-0689-40f5-965f-ea963ec5550a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000796', 'Имуно буст Капина/Лимон/Лимета 500ml', '2025@5.00: 128; 2026@5.00: 151; mex@5.00: 8'),
  ('666ed719-5b43-4175-b4fa-6403fffce804'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('66ed167b-ebf3-4147-8ad0-8d94002b96f4'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000891', 'ДИЕТ ШЕЈК чоколадо 500 g', '2025@5.00: 225; 2026@5.00: 166; mex@5.00: 11'),
  ('672c4097-671f-46f4-ae95-d8d59f261249'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000324', 'ПРОСТАТОЛ КОМПЛЕКС cps 30-сет2+1', '2025@5.00: 295; 2026@5.00: 137'),
  ('67cc6d0e-4f69-4b4c-aad3-fb6845b7ce84'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('680772d4-9e51-4a5f-ae72-491a0193e9e9'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '001635', 'МЕЛЕМ R&R 30 мл', '2026@18.00: 7; mex@18.00: 3'),
  ('6836933e-8fff-4ddd-b4f9-b43b10b67d33'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000982', 'Колаген Пептид со ВАНИЛА 200 гр', '2025@5.00: 499; 2026@5.00: 319; mex@5.00: 17'),
  ('69611da2-7280-4d5c-889f-0766e41f7a8c'::uuid, 0.180, 'sigma:by-name', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('69b7dd41-8c84-43c9-b795-e8f2adbf27f6'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005042', 'ELIXY-анти-инфламаторен гел  200 мл', '2025@18.00: 35; 2026@18.00: 11; mex@18.00: 4'),
  ('6a1b278a-fec5-41b0-8a64-86fc74430055'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000300', 'РЕСВЕРАТРОЛ КОМПЛЕКС 30 cps', '2025@5.00: 34; 2026@5.00: 22; mex@5.00: 12'),
  ('6a87c3c4-4153-42d9-898a-d2faa80a88b7'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('6b2e1c91-d2f2-4028-a068-b31cc61141e0'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000541', 'ТИГРОВА МАСТ 30ml', '2025@18.00: 107; 2026@18.00: 4; mex@18.00: 12'),
  ('6b3736b5-53e5-47b1-bbd6-1f2a657d10dd'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000584', 'ЧИА ТЕРАПИЈА со вит.Ц Лубеница 500ml', '2025@18.00: 154; 2026@18.00: 141; mex@18.00: 12'),
  ('6b399f77-3d74-4ff3-a2d8-d4ead6479ec5'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000652', 'ЧИА ТЕРАПИЈА со вит.Ц Jаболко 500ml', '2025@18.00: 185; 2026@18.00: 148; mex@18.00: 12'),
  ('6bb98d83-297a-455f-b61b-dedd449eb982'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000652', 'ЧИА ТЕРАПИЈА со вит.Ц Jаболко 500ml', '2025@18.00: 185; 2026@18.00: 148; mex@18.00: 12'),
  ('6c8ae9d1-016e-4ec0-8253-8a841e5ef269'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001203', 'СЕТ 2 -КРЕАТИН +1 Л-ГЛУТАМИН', '2025@5.00: 8'),
  ('6ce8f434-1566-4739-a8d6-cde599d10a6d'::uuid, 0.180, 'rule:cosmetic-18+mixed', NULL, NULL, NULL),
  ('6ceb9d34-c904-492f-91aa-d9e11b98e60a'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000923', 'Л-КАРНИТИН  60 cps', '2025@5.00: 125; 2026@5.00: 59; mex@5.00: 13'),
  ('6e180f62-aa41-425a-b5b7-ed7443b81345'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001173', 'АМИНО ЕНЕРЏИ БУСТ 500 мл', '2025@5.00: 53; 2026@5.00: 35; mex@5.00: 7'),
  ('6f03b6b6-afab-4bcb-a6e0-769d5ae02056'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001331', 'PRE WORKOUT POWDER 200 gr', '2025@5.00: 33; 2026@5.00: 47; mex@5.00: 2'),
  ('6f6d938b-3aec-46f4-952d-042e374309e8'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000942', 'ВИТАМИН Д3 30 tbl', '2025@5.00: 175; 2026@0.00: 2; 2026@5.00: 429; mex@0.00: 2; mex@5.00: 16'),
  ('6fbe74e1-5c04-46b7-8030-47677fba2962'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001007', 'СЕТ ДИЕТ ШЕЈК 2+ 1 СЛИМ КОМПЛЕКС', 'no 2025–2026 sales invoice'),
  ('70979ad8-507a-4c4d-94d6-061a8dba00f5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000398', 'ХЕПАТОЛ ФОРТЕ 30cps-сет 2+1', '2025@5.00: 49; 2026@5.00: 23'),
  ('71bece5b-129f-45d9-ad54-6dade62ce574'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001111', 'КИДС МУЛТИВИТАМИНС  60 tbl', '2025@5.00: 33; 2026@5.00: 1; mex@5.00: 6'),
  ('7204b8b9-1a9e-4afb-b25e-ddf4bfa14559'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001158', 'ЛИВЕР ДЕТОКС  90/1 cps 1+1 гратис', '2025@5.00: 2; 2026@5.00: 2'),
  ('720df4c8-5208-49e1-96d0-2e58c7137578'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('72db3682-3497-4395-83a8-9593ddacefdd'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001214', 'ГЛУКАТОЛ 180/1 cps', '2025@5.00: 41; 2026@5.00: 15; mex@5.00: 5'),
  ('737c41d4-9acd-4145-99e1-dafe1a6180b4'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('73b42da4-2eb6-4af8-ba56-446b740177d4'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000575', 'КВЕРЦЕТИН 30cps', '2025@5.00: 5; mex@5.00: 4'),
  ('74686b55-b6c3-4237-855a-af957a86ff65'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('74c4b953-4e9f-495e-a51f-1bf25f2e3de2'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001055', 'ALPHA  MALE 60 cps', '2025@5.00: 162; 2026@5.00: 144; mex@5.00: 14'),
  ('752ae710-df1b-4cb4-8b4f-279d634c88ff'::uuid, 0.180, 'sigma:by-name+mixed', '005023', 'ELIXY-Колаген серум 30 мл', '2025@18.00: 71; 2026@18.00: 38; mex@18.00: 12'),
  ('75748f13-03c1-4627-8917-61a7b6f55fa8'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000323', 'АЛОЕ РОЈАЛ 0,5 Л (сет 2+1)', 'no 2025–2026 sales invoice'),
  ('75fdf3e1-095f-44be-9bf4-371d7e31606f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000858', 'Гастро алое+гастро протект  сет 1+1', '2025@5.00: 35; 2026@5.00: 17'),
  ('7629a69c-a479-44a6-abd5-d932fad00a1c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005013', 'ELIXY-Серум снаил+јојоба', 'no 2025–2026 sales invoice'),
  ('763d7435-0bc7-4ef9-b4a3-f543186b0874'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001225', 'ДР.СЛИМ 90 цпс', '2025@5.00: 88; 2026@0.00: 1; 2026@5.00: 77; mex@0.00: 1; mex@5.00: 10'),
  ('76508de6-e3dc-419c-96ab-734a7cf1bfe9'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('766bf69e-8ae6-4ba0-90cd-c28f0dba98a4'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000301', 'ЦРНО ГОЏИ cps 30', '2025@5.00: 8; 2026@5.00: 1; mex@5.00: 4'),
  ('7672efa8-4fef-49bd-a848-e03010ea15f3'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000619', 'Слим комплекс+ Слим фибер 1+1 гратис', '2025@5.00: 6'),
  ('7705d06d-fccf-4fb2-80ed-0185de104d69'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005047', 'ELIXY Алое Крема SPF 20 50 мл', '2025@18.00: 41; 2026@18.00: 17; mex@18.00: 4'),
  ('7708d2bc-50ea-4487-8116-6dfeee3661bc'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002041', 'МУЛТИХИДРАТАНТНА КРЕМА 50мл', 'no 2025–2026 sales invoice'),
  ('7755d5c0-66ee-4ec6-93ae-fe7b8a47f4c6'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001539', 'NEUROFIX BIONATURAL 30/1', '2026@0.00: 2; 2026@5.00: 10; mex@0.00: 2; mex@5.00: 3'),
  ('776479c6-d2d2-4131-bf66-c4266dcf7e55'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005019', 'ELIXY Серум со витамин Ц', '2025@18.00: 69; 2026@18.00: 21; mex@18.00: 7'),
  ('777b1709-5b03-433a-a426-f3c5e0cebded'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('7797579a-49c9-4515-b3da-6b0c28cce2da'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000518', 'Витамин Ц со витамин Д3 за ДЕЦА 500 мл.', '2026@5.00: 2; mex@5.00: 1'),
  ('7846f678-c6f2-4c3c-bb39-e19856a36f2f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001335', 'TONGAKT ALI 60 cps', '2025@5.00: 26; 2026@5.00: 23; mex@5.00: 4'),
  ('7861752e-9269-46a7-81f5-a195b033ae23'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('78ffd052-4c06-4685-a09b-d92e4e1f41b5'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('79035f81-394a-4b45-82cf-8d132a3038b1'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005015', 'АЛОЕ БОДИ ГЕЛ 100ml', '2025@18.00: 94; 2026@18.00: 13; mex@18.00: 11'),
  ('794516ae-a9dd-41a6-94eb-c6c0d3e0cb8e'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('79a798bc-0da2-41e4-a38f-c09fe4d838d4'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000568', 'ГАСТРО ПРОТЕКТ 500ml', '2025@5.00: 388; 2026@5.00: 152; mex@5.00: 18'),
  ('79b72c76-20ee-46df-83e6-5b88e1b88c5e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000997', 'БОНЕ ПРОТЕКТ 30 cps (сет 2+1)', 'no 2025–2026 sales invoice'),
  ('7a2c40a2-a2ce-49ea-b2ff-57368b6fc4f5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001217', 'ТУРМЕРИК БООСТ 500 мл', '2025@18.00: 6; 2025@5.00: 81; 2026@5.00: 118; mex@5.00: 9'),
  ('7a343717-8efe-4225-a407-7e4e562f6d67'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('7b5e8083-bf95-498c-8385-9f5c15902220'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', 'ХЕЛАНКИ', 'ХЕЛАНКИ', 'no 2025–2026 sales invoice'),
  ('7b831313-344f-4dcf-8a34-b4ec644015bc'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001062', '100% WHEY ВАНИЛА  1.2 КГ', '2025@5.00: 103; 2026@5.00: 9; mex@5.00: 8'),
  ('7b9798fb-9c05-422d-9203-4e96f8a02d74'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000998', '100% WHEY PROTEIN-VANILA 1.5 kg', '2026@5.00: 1; mex@5.00: 1'),
  ('7bcae7de-f6a2-47aa-b6ad-3a3bc423b8e6'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('7c28153d-01a4-4bab-b0dd-8b3864e32f85'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001073', 'АШВАГАНДА  ЕКСТРАКТ 60/1 cps', '2025@5.00: 253; 2026@5.00: 304; mex@5.00: 8'),
  ('7c817483-e770-4cf5-bdd4-1fd83d5ceeee'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '001246', 'COLLAGEN FACE SERUM 30 ml KS', '2025@18.00: 3; mex@18.00: 2'),
  ('7caca41d-ec19-4e4d-9869-61e53470a7fd'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('7d7dc5e9-a7b5-46b3-8df2-a250f7c0abd7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001288', 'ENDURO MAX 30 cps', 'no 2025–2026 sales invoice'),
  ('7d97a94b-f331-47fa-bfd6-aa8cf83e1dd2'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('7de94a98-1abc-45e5-94aa-48f397178a4e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001129', 'МАГНЕСИУМ 325 мг 60/1 таблети', '2025@5.00: 131; 2026@0.00: 2; 2026@5.00: 406; mex@0.00: 2; mex@5.00: 6'),
  ('7e9b67ba-329f-4583-9b35-fac2cca41823'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001319', '100% WHEY ЧОКОЛАДО 2000 гр', '2025@5.00: 72; 2026@5.00: 154; mex@5.00: 3'),
  ('7ec6ce03-0c4a-46bf-98ca-c716dfe9df15'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000042', 'СНАИЛ КОМПЛЕКС cps 30', '2025@5.00: 529; 2026@5.00: 253; mex@5.00: 18'),
  ('7ecd116e-b183-48f7-bb85-b01a793db9d5'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000042', 'СНАИЛ КОМПЛЕКС cps 30', '2025@5.00: 529; 2026@5.00: 253; mex@5.00: 18'),
  ('7ed95220-fd77-492d-b292-c6145b82e65e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001525', 'D3 180/1 tab BIONATURAL', '2026@0.00: 2; 2026@5.00: 9; mex@0.00: 2; mex@5.00: 2'),
  ('7ef0056c-c771-4ec4-9e7d-f54cb3e502ff'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000334', 'ПМС КОМПЛЕКС 30cps-сет2+1', 'no 2025–2026 sales invoice'),
  ('7fd4a9e2-9bc5-4806-aa8b-71b3fbec72d8'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8065e5a7-ba7d-41f6-bca3-dfd8ee65db81'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000313', 'ЦИТРУС ЕКСТРАКТ 30cps', '2025@5.00: 6; mex@5.00: 3'),
  ('810126c7-24df-40f4-b35c-dfdfe11e396a'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005019', 'ELIXY Серум со витамин Ц', '2025@18.00: 69; 2026@18.00: 21; mex@18.00: 7'),
  ('820f88a4-a607-42fd-a175-4fd9ed5e7cc4'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000568', 'ГАСТРО ПРОТЕКТ 500ml', '2025@5.00: 388; 2026@5.00: 152; mex@5.00: 18'),
  ('827654fc-ad10-4dc5-8b64-7e4b5e98a802'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('846585d0-ab2a-4ec5-a3d3-1734d40a0752'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000583', 'ЧИА ТЕРАПИЈА со вит.Ц Диња 500ml', '2025@18.00: 140; 2026@18.00: 100; mex@18.00: 11'),
  ('84cb7e1c-b313-485d-b657-bdb4e8d3ecf6'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000306', 'ЗЕЛЕН ЧАЈ ЕКСТРАКТ 30 cps', '2025@5.00: 13; 2026@5.00: 8; mex@5.00: 8'),
  ('85048dcd-9dc9-4c32-b601-cfdcef9f2d4c'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005023', 'ELIXY-Колаген серум 30 мл', '2025@18.00: 71; 2026@18.00: 38; mex@18.00: 12'),
  ('85ad3161-5032-4d7e-ad91-357a7934ce64'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8627fe6d-2bad-4f47-9fd2-55ec293425bf'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001239', 'АРТРО ФЛЕКС 100мл', '2025@18.00: 53; 2026@18.00: 5; mex@18.00: 7'),
  ('86d5d8a7-0cf7-4b1e-ae61-fd7acf0db415'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000898', '100% WHEY PROTEIN-VANILA 1kg', '2026@5.00: 1'),
  ('87337325-528f-4007-96b2-fcc1262a55e3'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001584', 'ADENOFRIN 20/1 cps', '2026@0.00: 3; 2026@5.00: 9; mex@0.00: 2; mex@5.00: 3'),
  ('88fa8b43-c938-4365-8ccd-7e09ec1e4de7'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '2025@5.00: 34; 2026@5.00: 19; mex@5.00: 13'),
  ('89e9c66a-3038-4cc5-8bf1-b75fd884b613'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('8abe2b25-248a-415e-8380-197a40d490ec'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001076', 'ТРИБУЛУС ТЕРЕСТРИС 60/1 cps', '2025@5.00: 113; 2026@5.00: 70; mex@5.00: 11'),
  ('8ae08430-37c3-438a-b3cc-0d713bbfbc6a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001317', 'PROSTA FIX BIONATURAL 30 cps', '2025@5.00: 2; 2026@0.00: 2; 2026@5.00: 12; mex@0.00: 2; mex@5.00: 6'),
  ('8b1d6f5e-4404-48ff-b42c-fc5376c0cd0a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001026', 'ДР. СЛИМ 210 гр.', '2025@5.00: 29; 2026@5.00: 3; mex@5.00: 3'),
  ('8ba706ee-3589-461e-abe1-34e5465cab1a'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '2025@5.00: 34; 2026@5.00: 19; mex@5.00: 13'),
  ('8c651716-0a4f-4a11-a781-9bdbd27035cc'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('8c8aae63-75d8-45b8-9642-177b964c6e4d'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8ca92e9e-5c6f-409c-816f-9506a420a87a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000619', 'Слим комплекс+ Слим фибер 1+1 гратис', '2025@5.00: 6'),
  ('8d3f3962-0d5c-4085-9fc8-0fc39c53164b'::uuid, 0.180, 'sigma:by-name', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('8d550b53-7f73-4644-8aef-bc6e9f30d8aa'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074317', 'ТАВА 28цм', 'no 2025–2026 sales invoice'),
  ('8d63179a-3f49-44b3-868c-687c6e576aed'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000891', 'ДИЕТ ШЕЈК чоколадо 500 g', '2025@5.00: 225; 2026@5.00: 166; mex@5.00: 11'),
  ('8d7a5b1e-9674-48bc-9760-83c9f3ecb198'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001298', 'ТУРМЕРИК 425мл  1+1 НЕУРО АКТИВ', '2025@5.00: 2; 2026@5.00: 2'),
  ('8d7bd319-d858-4e42-9c7a-2c0545f73081'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000987', 'БОНЕ ПРОТЕКТ 30 cps', '2025@5.00: 12; 2026@5.00: 1; mex@5.00: 7'),
  ('8ddb22d8-ee9c-4e1d-bb28-eadf0c804cfb'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8e24764d-f01f-4104-9d83-73135a0aaf25'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000637', 'КУРКУМАКТИВ 500ml', '2025@5.00: 246; 2026@5.00: 264; mex@5.00: 18'),
  ('8e3a653d-a73b-4dd6-b63e-5703c6b9db8b'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8e560fb4-4fc0-4592-a6f5-801b6b4f8947'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000741', 'ДИАБЕТОЛ ФОРТЕ 30+30cps', '2025@5.00: 176; 2026@5.00: 44; mex@5.00: 1'),
  ('8e5e23e9-e74b-4e58-9a04-629414109c40'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000760', 'ХОЛЕСТОЛ КОМПЛЕКС СЕТ (2+1)', '2025@5.00: 65; 2026@5.00: 30'),
  ('8ea4c15a-df6d-48b0-b1ef-92d5234c1388'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8ea7ff11-d2a4-44ca-ba6c-e73a38d446ff'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000889', 'ДИЕТ ШЕЈК Ванила 500g', '2025@5.00: 215; 2026@5.00: 149; mex@5.00: 11'),
  ('8ed67773-3fdf-4ceb-8c02-09f204da7562'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000397', 'ДИЕТ ШОТС 500 мл', 'no 2025–2026 sales invoice'),
  ('8f08b33e-40f7-48ce-a52c-d1d15db38c48'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('8f5732dc-cf65-4cae-b1d2-1d4ae96fd479'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001539', 'NEUROFIX BIONATURAL 30/1', '2026@0.00: 2; 2026@5.00: 10; mex@0.00: 2; mex@5.00: 3'),
  ('8ff7d97c-8ac0-4b2b-a1c5-6a4b57cb0c8a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001072', 'ТУРМЕРИК КУРКУМИН 425 мл', '2025@5.00: 305; 2026@5.00: 103; mex@5.00: 16'),
  ('901ee0bf-0823-445d-bc72-7513129af760'::uuid, 0.180, 'sigma:crosswalk-HIGH', '048965', 'ТОСТЕР ЗА ЛЕПЧИЊА', 'no 2025–2026 sales invoice'),
  ('90f36677-e8ad-4b5a-984a-cc150d95ab4d'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000616', 'СЛИМ ФИБЕР 30cps', '2025@5.00: 92; 2026@5.00: 79; mex@5.00: 9'),
  ('90fd6a97-7fdb-4113-9d23-1763eabb00e5'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('910d1192-30c0-40eb-a83f-a5432160fbac'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000940', 'ЦИНК 30 tbl', '2025@5.00: 221; 2026@0.00: 2; 2026@5.00: 440; mex@0.00: 2; mex@5.00: 15'),
  ('910d146f-97b6-406f-8269-d26be529b13b'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('910e0f3d-8f9e-424b-b28c-d36a1cbf2793'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('91a155f6-b4b5-447d-a0fa-cb281df6cf50'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000891', 'ДИЕТ ШЕЈК чоколадо 500 g', '2025@5.00: 225; 2026@5.00: 166; mex@5.00: 11'),
  ('91a913a5-fd5e-4b10-86b8-8f45df7c3dc3'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002006', 'Дневна крема против брчки', 'no 2025–2026 sales invoice'),
  ('924d3963-ad86-42e3-af01-4f60e93ab1c2'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('92c7f18d-20dd-4c5a-8767-682b6cff480e'::uuid, 0.050, 'sigma:by-name+mixed', '000957', 'БЦАА  во прав 200 гр.', '2025@5.00: 155; 2026@5.00: 152; mex@5.00: 14'),
  ('92ffb0db-e8c0-433e-bc54-707c1281f380'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001536', 'PARAFIX BIONATURAL 30/1cps', '2026@0.00: 3; 2026@5.00: 10; mex@0.00: 2; mex@5.00: 3'),
  ('931cb587-1f07-4687-a337-0ac9c788c700'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001528', 'ВИТАМИН Б6 365/1 таб', '2026@5.00: 53; mex@5.00: 1'),
  ('935a14dc-1510-49ba-8107-78843343360c'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('9377a511-1a9e-4199-bc04-965133bd5dea'::uuid, 0.050, 'sigma:crosswalk-HIGH', '002448', 'Протеин.шејк во прав какао 500 гр', 'no 2025–2026 sales invoice'),
  ('938de0ca-28a1-4c99-9ade-3ecf59c559e6'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000618', 'СЛИМ ФИБЕР  30 cps 1+1', 'no 2025–2026 sales invoice'),
  ('93bd72c4-db7b-4070-bd91-6e4fed785db9'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('93c6fe08-e81b-4a01-bd46-cdff87100dde'::uuid, 0.180, 'sigma:crosswalk-HIGH', '048307', 'МАШ.ЗА МЕЛЕЊЕ КАФЕ', 'no 2025–2026 sales invoice'),
  ('94622941-aa09-4feb-8d21-67c79240e0c8'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001187', 'АРТРОФЛЕКС 180 таблети', '2025@5.00: 32; 2026@5.00: 2; mex@5.00: 3'),
  ('946efd4e-908b-4cce-ade6-195e330f1fea'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001311', 'ВЕНО ГАРД 30 cps', '2025@5.00: 8; 2026@5.00: 26; mex@5.00: 7'),
  ('94c86a2d-0258-4687-8ca4-bd591f6e287a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001293', 'NATURAL LAXATIVE 100% 90/1 cps', '2025@5.00: 52; 2026@5.00: 21; mex@5.00: 5'),
  ('9522a565-edb3-4804-b3b8-cb40b5331723'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000195', 'КУРКУМИН ЛИКВИД 0,5 (сет 2+1)', 'no 2025–2026 sales invoice'),
  ('95b5842c-8991-4419-8ddd-21162a6984d9'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000595', 'Гастро протект+Гастро Алое 2+2', '2025@5.00: 85; 2026@5.00: 20'),
  ('96432842-2aa1-4b95-a2ed-49e00f6ab6d6'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000603', 'ВИТАМИН Б6 60tbl', '2025@5.00: 3; 2026@5.00: 2; mex@5.00: 3'),
  ('96b8ec07-c52b-48c7-9bb9-500b09b64497'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('96dece7d-5ead-4734-b167-1d632691dad3'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005027', 'ТЕРМО ГЕЛ 290ml+КРИО ГЕЛ 290ml', '2025@18.00: 2; 2026@18.00: 2'),
  ('985b7f2a-08fa-4ec5-abf6-00d3f723664e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000601', 'ВИТАМИН Д3 60 tbl', '2025@5.00: 2'),
  ('98a5c137-4946-49ac-8eb5-7bddc1125d61'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('98cf43a6-cba1-448a-adcc-e214a1cdf466'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000537', 'ПРОПОЛИС КАПКИ 5% - 50 ml', '2025@5.00: 2; mex@5.00: 1'),
  ('9a459687-5384-40c1-aad3-2e3290dbb332'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000523', 'БИЛБЕРИ НАТУРА 30cps', '2025@5.00: 27; 2026@0.00: 1; 2026@5.00: 26; mex@0.00: 1; mex@5.00: 9'),
  ('9ae2a1a7-a645-4404-afe6-1bd6de88ecef'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000456', 'ХЛОРОФИЛ ТЕЧЕН 500ml', '2025@5.00: 11; 2026@5.00: 14; mex@5.00: 8'),
  ('9b8b64ef-8f56-4153-9d6a-265be1bf1fc7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('9bbc3c65-a610-49a3-86ff-b559ff7e6550'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005040', 'ELIXY -крем за лице HYDRATING 100 мл', '2025@18.00: 19; 2026@18.00: 2; mex@18.00: 2'),
  ('9bda3706-1108-4f2b-8734-f4eb18a56f5e'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000018', 'Електрично ќебе (120х150cm)', 'no 2025–2026 sales invoice'),
  ('9bdf8924-35a0-40d5-a270-aa7783d756ae'::uuid, 0.180, 'sigma:by-name+mixed', '005023', 'ELIXY-Колаген серум 30 мл', '2025@18.00: 71; 2026@18.00: 38; mex@18.00: 12'),
  ('9c08eb88-fc01-4050-9983-fb4df76c8c2f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001427', 'МАЧА со КОЛАГЕН 175 гр', '2025@5.00: 33; 2026@5.00: 188; mex@5.00: 3'),
  ('9c30effd-c80b-477e-bc31-57f0a6967f0a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001058', 'ХЕМОРО ФОРТЕ 30 cps', '2025@5.00: 127; 2026@5.00: 69; mex@5.00: 15'),
  ('9e714626-70b3-480b-a64c-eb1ab121c5d0'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000650', 'КУРКУМАКТИВ 500ml-сет2+1', '2025@5.00: 125; 2026@5.00: 71'),
  ('9f22d4af-5efb-4a08-84c7-8db624ee3adc'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001074', 'ЗЕЛЕН ЧАЈ ЕКСТРАКТ 60/1 cps', '2025@5.00: 61; 2026@5.00: 40; mex@5.00: 11'),
  ('9f6001cd-5521-4eb4-b234-28460afdfa15'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001277', 'NATURAL FIBER 100% 210 gr', '2025@5.00: 52; 2026@5.00: 20; mex@5.00: 5'),
  ('9f63c2a4-93d3-41a2-9e0b-683b2fafe8c2'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000796', 'Имуно буст Капина/Лимон/Лимета 500ml', '2025@5.00: 128; 2026@5.00: 151; mex@5.00: 8'),
  ('a02bf841-35cb-493e-a4f9-501eb79cf267'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001319', '100% WHEY ЧОКОЛАДО 2000 гр', '2025@5.00: 72; 2026@5.00: 154; mex@5.00: 3'),
  ('a05eabed-4e65-4fe8-b3f4-62300fcbbb3a'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000328', 'ХЕПАТОЛ ФОРТЕ 30 cps', '2025@5.00: 57; 2026@5.00: 45; mex@5.00: 12'),
  ('a07f7c8c-d2cd-4593-b929-bd30ed6cd3fe'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000889', 'ДИЕТ ШЕЈК Ванила 500g', '2025@5.00: 215; 2026@5.00: 149; mex@5.00: 11'),
  ('a09d70c8-ca38-49d0-965a-3175978e33b3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000594', 'УРО ПРОТЕКТ 30 cps', '2025@5.00: 78; 2026@5.00: 73; mex@5.00: 15'),
  ('a0a499a0-29b5-4e06-aea2-1cf85b5fde80'::uuid, 0.050, 'sigma:by-name', '000265', 'ПРОСТАТОЛ КОМПЛЕКС cps 30', '2025@5.00: 513; 2026@5.00: 329; mex@5.00: 19'),
  ('a0ac8f5a-e48f-4b7e-b2cd-65ac0c1a1db8'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001019', 'CALM антистрес формула 30/1', '2025@5.00: 111; 2026@5.00: 114; mex@5.00: 13'),
  ('a16293b8-9113-4729-9b65-520f2026cba0'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('a168b5e5-9f2e-414d-9289-025b17ca2ee2'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000957', 'БЦАА  во прав 200 гр.', '2025@5.00: 155; 2026@5.00: 152; mex@5.00: 14'),
  ('a1829ebc-ba7c-4a14-861f-f2b1976b05e5'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('a246fb90-bc7c-43da-b1b7-7cd67c81661c'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('a2b31d95-37b6-44f5-bb4f-7b34742503de'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001526', 'ZINC 180/1 tab BIONATURAL', '2026@0.00: 2; 2026@5.00: 9; mex@0.00: 1; mex@5.00: 2'),
  ('a30118d5-bb05-4596-b8f3-03967d34689b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001303', 'СЕТ Д-маноза 60/1+УРО протект 60/1', '2025@5.00: 24'),
  ('a34489cb-6682-4e19-9a7f-fa03a9368ab0'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('a359c086-1564-48be-937f-0c785b8a42f6'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('a35cb6a4-83eb-4366-8b13-92b596191be0'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001159', 'САМБУКУС сируп 250 мл', '2025@5.00: 102; 2026@5.00: 56; mex@5.00: 15'),
  ('a396b256-bac2-454e-83b8-5d764059662b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000054', 'Инстант кафе Реиши 2,5 гр', 'no 2025–2026 sales invoice'),
  ('a4e10c30-f199-4f6b-8bf7-6cb946df2734'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000166', 'НЕУРО АКТИВ 60 cps', '2025@5.00: 195; 2026@5.00: 168; mex@5.00: 13'),
  ('a5791c69-cb0a-4fef-9691-30c926804c6e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001493', 'CYSTI CARE 30/1 cps', 'no 2025–2026 sales invoice'),
  ('a5b3ccc3-5a72-471b-bbdd-4e16f47eb15e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000267', 'АЛОЕ ВЕРА ГЕЛ СО ЛИМОН 1Л', 'no 2025–2026 sales invoice'),
  ('a5ce461e-69cb-409e-8295-4badfb20a70f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000165', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 0,5Л', '2025@5.00: 135; 2026@5.00: 81; mex@5.00: 17'),
  ('a680711c-bacc-4899-9781-894762aa6871'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001625', '100 %WHEY без вкус 400 гр', 'no 2025–2026 sales invoice'),
  ('a69aad11-fbc9-4d96-a4d9-1256b05bd007'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('a6d0e53f-2e1d-4a8d-bf22-4753b755bf7c'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000994', 'АЛОЕ АРОНИЈА со ВИТ Ц ,Д3 И ЦИНК 500мл', '2025@5.00: 165; 2026@5.00: 280; mex@5.00: 15'),
  ('a76b06d1-755b-47d8-ae12-8e7d3b885670'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('a787c8b1-205a-4b2c-84c2-db3076dc3f54'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001228', 'НУТРИ ШЕЈК-со вкус на чоколадо 500 гр.', '2025@5.00: 208; 2026@5.00: 213; mex@5.00: 14'),
  ('a7932e0b-f596-4410-aa66-1aa48d5e55b6'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '002366', 'Магнезиум гел 250мл', 'no 2025–2026 sales invoice'),
  ('a79858b2-4c26-40a8-b44e-4c5cf4661647'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('a79c814f-55f6-427a-af83-fec127e7b450'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000597', 'Витамин Ц за деца со Д3 250 мл.', '2025@5.00: 49; 2026@5.00: 12; mex@5.00: 11'),
  ('a8040b9e-f07a-4058-906d-b689f45e8067'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000604', 'Витамин Ц за ВОЗРАСНИ    250 мл.', '2025@5.00: 134; 2026@5.00: 93; mex@5.00: 14'),
  ('a84122aa-3f1e-495c-bcf7-0a16b07e4567'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('a84853ee-0171-4e60-98ee-61ea36adecde'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000308', 'МАКА ЕКСТРАКТ 30 cps', '2025@5.00: 37; 2026@5.00: 9; mex@5.00: 5'),
  ('a8676822-10c4-4c90-96c9-0dc56b4c03c2'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002358', 'Витамин Б3 серум 30мл', 'no 2025–2026 sales invoice'),
  ('a8aeaa5d-03cc-446c-880f-1e115968547a'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000562', 'АЛЕРГО ПРОТЕКТ 500мл.', '2025@5.00: 65; 2026@5.00: 35; mex@5.00: 10'),
  ('a91db622-5716-482a-b1dc-ece926cc7a53'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000425', 'АЛОЕ СОК со вкус на портокал 500 ml', 'no 2025–2026 sales invoice'),
  ('a9393b5e-2973-4ec2-ab76-98dc0953894f'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('a93a0b66-1aca-408d-a3c3-57b6a3316ab4'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001571', 'MAGNESIUM CITRAT 325mg 150/1 tab', '2026@0.00: 1; 2026@5.00: 455; mex@5.00: 6'),
  ('a94536dc-c34e-4b4b-818b-e6927c6433b8'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('a9709e38-ede8-4d80-b1fe-1daf1fb148b9'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000263', 'МАШРОМ КОМПЛЕКС  0,5 Л', 'no 2025–2026 sales invoice'),
  ('aaa9c76d-bbe0-47e1-828a-9c281476b9a0'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('ab019b02-cf70-44a1-bf1e-79708ce4fc24'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000312', 'ТРИБУЛУС ТЕРЕСТРИС 30cps', '2025@5.00: 34; 2026@5.00: 19; mex@5.00: 13'),
  ('ab0619ab-4e13-49c7-8ed0-b97bbb4ef0ab'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001659', 'MAGNESIUM BISGLYCINATE 120/1 tab', '2026@5.00: 105; mex@5.00: 2'),
  ('ab09eec7-638e-44a7-ab83-1b820df4c9cb'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001313', 'ARTHRO FIX BIONATURAL 30/1', '2025@5.00: 2; 2026@0.00: 3; 2026@5.00: 12; mex@0.00: 2; mex@5.00: 5'),
  ('ac669597-6a08-4aa8-9fe5-f8e1da520852'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001019', 'CALM антистрес формула 30/1', '2025@5.00: 111; 2026@5.00: 114; mex@5.00: 13'),
  ('ad3b4bee-9b32-489b-825c-e503b757b197'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '001239', 'АРТРО ФЛЕКС 100мл', '2025@18.00: 53; 2026@18.00: 5; mex@18.00: 7'),
  ('ae2d96c0-9946-4db4-9d8a-c3502ff31c17'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('ae4b09f0-ee8a-4f89-b93c-427c5d68c668'::uuid, 0.050, 'sigma:crosswalk-HIGH', '051668', 'ТАБЛЕТ-СТ95', 'no 2025–2026 sales invoice'),
  ('ae56d5fe-3ac3-407b-98d3-8aaa16d8ce26'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('ae65b514-a623-4352-855a-3baea5e2fa7e'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('af003807-be7e-4355-9c9d-b82b4cbbce8f'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001298', 'ТУРМЕРИК 425мл  1+1 НЕУРО АКТИВ', '2025@5.00: 2; 2026@5.00: 2'),
  ('af9afdf2-6f75-402e-a2dd-798b5634bb25'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('afc2ea05-3e11-49b8-842c-cd53d4dd52b7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001406', 'TERMINATOR - Shredded Combo', '2025@5.00: 33; 2026@5.00: 7; mex@5.00: 1'),
  ('afc591b4-8eb6-447d-b63a-a68e44d88f9f'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000234', 'ЕЛДЕРБЕРИЛ Имун сируп 250 мл.', '2025@5.00: 12; mex@5.00: 7'),
  ('afd65f61-bcf3-448c-a035-07296c1992f5'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('b01ce730-f4a6-4f9b-9011-bda12fcfd37d'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000109', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 1Л', '2025@5.00: 725; 2026@5.00: 421; mex@5.00: 21'),
  ('b0549de4-093f-4e08-840b-ede72939d5f9'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000600', 'ДИАБЕТОЛ сет 2+2', 'no 2025–2026 sales invoice'),
  ('b056281f-2005-4254-8692-f51f8eeb28fa'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001078', 'ХИАЛУРОН 5  90 гр (1+1)', '2025@5.00: 2'),
  ('b070ca90-697f-459f-ad93-defbbdd9b0d5'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000308', 'МАКА ЕКСТРАКТ 30 cps', '2025@5.00: 37; 2026@5.00: 9; mex@5.00: 5'),
  ('b0f2fb7c-8b4b-491b-8d31-f33f516e1b6a'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('b20942e6-f82e-40f7-9e71-7e4b304362c7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001407', 'FIT&LEAN - Weight loss Combo', '2025@5.00: 20; 2026@5.00: 1'),
  ('b226b5c4-329b-4366-841a-8024a0de4c8b'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000273', 'ГЛУКОЗАМИН СУЛФАТ 30 cps', '2025@5.00: 202; 2026@5.00: 97; mex@5.00: 16'),
  ('b238e186-2f4d-413a-a721-ff5a127c514d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000423', 'ИМУНО КИДС 500мл', 'no 2025–2026 sales invoice'),
  ('b2569b53-1a2d-4e33-936b-4eb0c719f7a8'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('b304a32c-4fe9-414c-8114-1f42ddee893a'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002390', 'СЛИМ ТЕРМО СЕРУМ ЗА СЛАБЕЕЊЕ 250 мл', 'no 2025–2026 sales invoice'),
  ('b3efc2d8-5e6d-46a2-b6d3-d95e0545b21f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001033', 'ИЗО МАКС ЈАГОДА 250 гр', '2025@5.00: 101; 2026@5.00: 28; mex@5.00: 8'),
  ('b3f71472-0600-43a9-9b24-338de4b1ff68'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005030', 'ELIXY-ТЕРМО ГЕЛ 200ml+КРИО ГЕЛ 200ml', '2025@18.00: 64; 2026@18.00: 13; mex@18.00: 5'),
  ('b451d55c-44dd-44ec-9d47-6c64a7d9c5c9'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000300', 'РЕСВЕРАТРОЛ КОМПЛЕКС 30 cps', '2025@5.00: 34; 2026@5.00: 22; mex@5.00: 12'),
  ('b4a09123-a63a-4289-a5d1-cfb4d48a85bc'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002360', 'Витамин Б3 флуид-очи 15мл', 'no 2025–2026 sales invoice'),
  ('b4b4629a-65e7-4729-b100-9efd4eb878d3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001630', 'VITAMIN D3+K2+BOR 180/1 tab', '2026@5.00: 121; mex@5.00: 3'),
  ('b5775be5-c1a3-47cc-89c6-56e824ec78c1'::uuid, 0.180, 'sigma:crosswalk-HIGH', '075551', 'Стапчеста правосмикалка 2во1', 'no 2025–2026 sales invoice'),
  ('b61cf590-a58a-4383-addd-6adf14717179'::uuid, 0.180, 'sigma:crosswalk-HIGH', '076466', 'ДАСКА ЗА ПЕГЛАЊЕ', 'no 2025–2026 sales invoice'),
  ('b62c03cc-e713-4f53-9eef-6a13c6b9dc76'::uuid, 0.050, 'sigma:crosswalk-HIGH', '004003', 'ОБЕН Витамин Ц Комплекс 500ml', 'no 2025–2026 sales invoice'),
  ('b633d588-a950-40ee-971a-e20c7da869be'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001054', 'ВИТАМИН Ц-1000  60 cps', '2025@5.00: 185; 2026@5.00: 155; mex@5.00: 15'),
  ('b65a9329-0f45-402f-a9bf-b7357c1ab3db'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001187', 'АРТРОФЛЕКС 180 таблети', '2025@5.00: 32; 2026@5.00: 2; mex@5.00: 3'),
  ('b66acbb5-287c-4dff-98a0-69c9c3c374e7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001128', 'ВИТАМИН Ц 500 мг 60/1 таблети', '2025@5.00: 58; 2026@5.00: 165; mex@5.00: 9'),
  ('b724ffd0-5332-4238-ab2f-74ab6ef27297'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001247', 'Сет АЛФА МАЛЕ 2+1 ТРИБУЛУС 60/1', '2025@5.00: 22; 2026@5.00: 2'),
  ('b73c9483-4766-4a28-908b-04a906affe3a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000329', 'СПИРУЛИНА КАПСУЛИ cps 30', 'no 2025–2026 sales invoice'),
  ('b78bc6f1-3989-4945-a38a-85843d77f4c2'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000797', 'Имуно буст ПОРТОКАЛ-АНАНАС 500ml', '2025@5.00: 155; 2026@5.00: 174; mex@5.00: 11'),
  ('b78d1fb1-936c-420f-8940-a13e0b82348b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001436', 'OXI JET POWER 1+1', 'no 2025–2026 sales invoice'),
  ('b8dec697-532d-4951-a2d7-959829990304'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000923', 'Л-КАРНИТИН  60 cps', '2025@5.00: 125; 2026@5.00: 59; mex@5.00: 13'),
  ('b8ff0ccb-ba70-48c3-b9a6-2dad9f6f34e1'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001692', 'Dr Becker NeuroCare 20/1 cps', 'no 2025–2026 sales invoice'),
  ('b9600d6c-73dc-435c-9e96-b5d24ffd0539'::uuid, 0.180, 'sigma:crosswalk-HIGH', '072599', 'РАЧЕН МИКСЕР', 'no 2025–2026 sales invoice'),
  ('b9dc18d8-e10c-4487-8af8-641586862c5f'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002371', 'Алое Вера гел 250мл', 'no 2025–2026 sales invoice'),
  ('ba7cca60-665f-46dc-a674-e63cf1bee5f9'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000615', 'СЛИМ КОМПЛЕКС 30cps', '2025@5.00: 121; 2026@5.00: 103; mex@5.00: 7'),
  ('bac77d4a-c001-481a-b36e-d359b9d0ddb4'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000636', 'БРАИН АКТИВ 30cps', '2025@5.00: 183; 2026@5.00: 139; mex@5.00: 19'),
  ('bb76464a-3047-456e-bfca-63cce27c1038'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('bbb88f26-ae68-4fd1-81d1-9303ddecc598'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('bc5b87ea-0def-47e9-bffc-e37a56cb245f'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('bc755924-17bd-4b5d-b761-956403be4446'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000412', 'ДИАБЕТОЛ ФОРТЕ 30cps', '2025@5.00: 180; 2026@5.00: 114; mex@5.00: 18'),
  ('bc762089-2db5-4513-afd1-452dc50c4f61'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001229', 'НУТРИ ШЕЈК-со вкус на јагода 500 гр.', '2025@5.00: 212; 2026@5.00: 172; mex@5.00: 13'),
  ('bcc3c57d-7526-4e15-ab2f-8f9850a03a03'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005037', 'ELIXY-hyaluronic acid-collagen&aloe vera', '2025@18.00: 5; 2026@18.00: 40; mex@18.00: 8'),
  ('bcc99e78-9b8d-4697-9008-6cfa4500c579'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001026', 'ДР. СЛИМ 210 гр.', '2025@5.00: 29; 2026@5.00: 3; mex@5.00: 3'),
  ('bcd0186d-c0ae-43c9-bcef-ee35bc6d7edd'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001228', 'НУТРИ ШЕЈК-со вкус на чоколадо 500 гр.', '2025@5.00: 208; 2026@5.00: 213; mex@5.00: 14'),
  ('bdaa45bd-6456-436d-9b5f-13ea6148a66e'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('bdb3eacf-4c30-4b7a-a90d-0740f3311c7b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002815', 'Шампон Чичак 250 мл', 'no 2025–2026 sales invoice'),
  ('bdc79d87-8e42-430d-8925-c3b010ca257f'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001312', 'SLIM FIT BIONATURAL 30/1', '2025@5.00: 1; 2026@0.00: 2; 2026@5.00: 11; mex@0.00: 2; mex@5.00: 4'),
  ('be0c8b86-9734-4dbc-b2c4-14fdc01f83e7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('be3bbd04-5308-4be9-bb75-dbccaeb27268'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('be9d3157-f13d-4dc9-a172-c002be268ffe'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000877', '100% WHEY PROTEIN-COKOLADO 1kg', '2025@5.00: 1; 2026@5.00: 1; mex@5.00: 1'),
  ('bef73330-598a-4696-bad2-7e067d00d68a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001601', 'MASS GAINER 3 kg', '2026@5.00: 22'),
  ('bef8a560-6d62-4378-9159-fa765cc8b9a2'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001073', 'АШВАГАНДА  ЕКСТРАКТ 60/1 cps', '2025@5.00: 253; 2026@5.00: 304; mex@5.00: 8'),
  ('bf3d2d79-07ed-4141-98a7-f0ebb85d406d'::uuid, 0.180, 'sigma:by-name+mixed', '005023', 'ELIXY-Колаген серум 30 мл', '2025@18.00: 71; 2026@18.00: 38; mex@18.00: 12'),
  ('bf6e391d-a9b3-4aef-9c74-e7446ae19578'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('bf9e7307-fa6a-4bd0-a9c3-c6da9982d057'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('bfcfb81c-fb11-4216-9211-e6f4a7dc754a'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '001635', 'МЕЛЕМ R&R 30 мл', '2026@18.00: 7; mex@18.00: 3'),
  ('c0797a03-be0f-49f2-bcee-17abcefe0bd0'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c262d23d-ab3c-4eac-82dd-3400e50b1b9e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000566', 'ИМУНО КИДС 500 мл.-сет2+1', 'no 2025–2026 sales invoice'),
  ('c346c07c-55c4-480b-9556-17509d64ec6d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000600', 'ДИАБЕТОЛ сет 2+2', 'no 2025–2026 sales invoice'),
  ('c3ce5bde-6967-4564-8c58-4a085305aad7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001200', 'ФЕММЕ 7 60 cps', '2025@5.00: 157; 2026@0.00: 1; 2026@5.00: 108; mex@0.00: 1; mex@5.00: 16'),
  ('c3dc6fdf-5648-4802-95f1-5d9ad5c04d8e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000677', 'УРО ПРОТЕКТ + Д-МАНОЗА (СЕТ 2+2)', '2025@5.00: 50'),
  ('c45c905a-6c09-4ffe-8a21-49cfe7c5298c'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c4ab9c1f-66a5-4451-bb00-e1d1c38b1dd3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001026', 'ДР. СЛИМ 210 гр.', '2025@5.00: 29; 2026@5.00: 3; mex@5.00: 3'),
  ('c4beaf4b-ee52-497f-9902-fa2177605e11'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c4cfd3f0-9e87-40b6-8f6f-aaaa3fd3e8c7'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c57ec1bd-6a4c-48e0-8744-637b9f68d6fa'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001515', 'GASTRO COMFORT 30/1 cps', 'no 2025–2026 sales invoice'),
  ('c5baa58c-238c-442d-8ee6-66147c7709ec'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('c5d5659f-8997-41c5-aa68-cf98032c4215'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000489', 'БРОНХО ПРОТЕКТ 500ml', '2025@5.00: 404; 2026@5.00: 164; mex@5.00: 17'),
  ('c6281a6d-8493-4b12-b670-1fc7f0b201f2'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('c6c3e56a-7eae-4643-81e8-9fda4c29053a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000942', 'ВИТАМИН Д3 30 tbl', '2025@5.00: 175; 2026@0.00: 2; 2026@5.00: 429; mex@0.00: 2; mex@5.00: 16'),
  ('c6d0758c-c6de-43ac-8530-74db6cba0ecc'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('c6fd33aa-b25f-476a-9a20-6665e38fa0f9'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c7a1c65e-28f5-44a5-84d7-b5edb348584c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000612', 'ПРОСТАТОЛ КОМПЛЕКС сет 2+2', 'no 2025–2026 sales invoice'),
  ('c7ae112b-8cea-4701-9f19-c2e1efb8a173'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001150', 'ОСТЕО ФИКС 180 tab', '2025@5.00: 54; 2026@5.00: 10; mex@5.00: 4'),
  ('c7cbb799-4f93-476e-b21f-d5c1ea8ce180'::uuid, 0.180, 'sigma:crosswalk-HIGH', '073494', 'Стапчест Блендер+сецко 3 во1', 'no 2025–2026 sales invoice'),
  ('c801c3cc-c3e5-4fec-aeb8-733c546d33c7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('c8b2e889-6da4-4770-a02e-90a2cadfd87f'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('c91b6a18-a12c-48ec-bae5-eeb629294f1f'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001113', 'Колаген Пептид -БЕЗ ВКУС  200 гр', '2025@5.00: 294; 2026@5.00: 118; mex@5.00: 14'),
  ('c92edc8f-bf67-4afd-9462-570d30dd56c5'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('c955d1bf-325b-44c7-bb7d-29ed4d5ea38d'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005012', 'ELIXY Хијалурон и Алое серум 30ml', '2025@18.00: 128; 2026@18.00: 30; mex@18.00: 13'),
  ('c968e99f-9a8b-45c6-b65e-1ea66b250afc'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('c9c1485c-19b5-4b9d-850a-7d5d734292c3'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005048', 'ELIXY  Matcha Face cream 50 ml', '2026@18.00: 26'),
  ('c9d60f70-d6d5-4666-8c06-f788f5690379'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001641', 'MAGNESIUM GEL 50 ml', '2026@18.00: 86; mex@18.00: 2'),
  ('ca763591-7fd6-407c-a8d9-0d5ece3e7263'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002327', 'Ноќна крема со смил 50мл', 'no 2025–2026 sales invoice'),
  ('cab4d37c-c2c6-4d6b-9802-87ca9c34052f'::uuid, 0.050, 'sigma:by-name', '001468', 'НУТРИ СУПА РАСТИТЕЛЕН МИКС 500 гр', '2026@5.00: 75; mex@5.00: 4'),
  ('cadfbb1f-b3a8-4b91-a31b-08831338464b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002374', 'Веногел 250мл', 'no 2025–2026 sales invoice'),
  ('cc128e1d-22b8-4333-902c-80dc784fe3ba'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002006', 'Дневна крема против брчки', 'no 2025–2026 sales invoice'),
  ('cc1d65e9-9ff7-4fe0-9096-2d2c77105cad'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('cc561012-c751-4d67-84ec-40c076b49388'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000605', 'ТЕЧЕН КОЛАГЕН 250 мл.', '2025@5.00: 40; 2026@5.00: 6; mex@5.00: 9'),
  ('cc68b664-9703-422a-9e56-78db5bfda7ca'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000593', 'Д-МАНОЗА 30cps', '2025@5.00: 46; 2026@0.00: 1; 2026@5.00: 61; mex@0.00: 1; mex@5.00: 12'),
  ('cd011bec-8928-42ac-b4ce-7278ada0fe3c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001305', 'СЕТ НУТРИ ШЕЈК ВАНИЛА 2+1', '2025@5.00: 6; 2026@5.00: 3'),
  ('cd15ebd0-c54e-4828-9024-e5664302e75e'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('cd19c64c-519f-434f-b8e4-deaa66c04d47'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000877', '100% WHEY PROTEIN-COKOLADO 1kg', '2025@5.00: 1; 2026@5.00: 1; mex@5.00: 1'),
  ('cd718786-aa16-4eba-ab00-a896dbab4840'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('cdad0a01-9451-4a2f-ac55-fb2eab0e251e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('cdcb1f92-99cd-4137-bb5e-d961e1728d3c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '071179', 'СОКОВНИК', 'no 2025–2026 sales invoice'),
  ('ce21e674-233a-43cf-a197-cbfff88ce280'::uuid, 0.050, 'sigma:by-name', '000413', 'ЦРВЕН ОРИЗ 30 cps.', '2025@5.00: 20; 2026@5.00: 1; mex@5.00: 8'),
  ('ce455c6d-0e66-4b2e-8740-c44ec802ab14'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('ce4ff9e0-eb7d-4176-8b20-4b9e9b1783ce'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000561', 'СПИРУЛИНА 150+150 tbl', 'no 2025–2026 sales invoice'),
  ('cee5888c-f3e8-4694-baaf-ef6f585a7306'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002006', 'Дневна крема против брчки', 'no 2025–2026 sales invoice'),
  ('cf38ad20-8608-4a81-b852-d9b5c7d3e0cc'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001315', 'ALPHA MALE BIONATURAL 30/1', '2025@5.00: 1; 2026@0.00: 2; 2026@5.00: 11; mex@0.00: 2; mex@5.00: 4'),
  ('cf42ec22-935b-4f25-a7f4-bd58ae7b7ebe'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000994', 'АЛОЕ АРОНИЈА со ВИТ Ц ,Д3 И ЦИНК 500мл', '2025@5.00: 165; 2026@5.00: 280; mex@5.00: 15'),
  ('cf5c31d3-36dd-4e13-9819-1de34706966c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000882', 'ХЕПАТОЛ ФОРТЕ 30+30 cps', '2025@5.00: 64; 2026@5.00: 8; mex@5.00: 1'),
  ('cf67bd5d-9a67-44f0-b64b-1ce7d9f6b69c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000944', 'ВИТАМИН Б6  30tbl', '2025@5.00: 147; 2026@0.00: 2; 2026@5.00: 339; mex@0.00: 2; mex@5.00: 15'),
  ('cf71eecc-5289-4e4b-bfa0-93d19ad204e7'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001058', 'ХЕМОРО ФОРТЕ 30 cps', '2025@5.00: 127; 2026@5.00: 69; mex@5.00: 15'),
  ('cf9ba0c0-2f4e-456e-9766-380967b9fbe9'::uuid, 0.180, 'sigma:crosswalk-HIGH', '067353', 'ПЛИНСКО РЕШО', 'no 2025–2026 sales invoice'),
  ('cfba782a-d2d0-4d2b-bddb-daa120d4c49e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001625', '100 %WHEY без вкус 400 гр', 'no 2025–2026 sales invoice'),
  ('cfeea178-f0bc-4c4c-a989-032112ffaf5a'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '001641', 'MAGNESIUM GEL 50 ml', '2026@18.00: 86; mex@18.00: 2'),
  ('d14984b1-5fc5-41bc-80a4-95ba6e453b18'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001071', 'ПАРА ДЕТОКС 30 cps', '2025@5.00: 58; 2026@5.00: 31; mex@5.00: 13'),
  ('d1a01a3e-6137-4cb5-bde7-d6e8c52e4ddd'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('d1f24e14-b0d4-42c1-b184-830f3099a79a'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('d1f5c8d7-cf12-4198-a5dc-ce1cac5e5362'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000165', 'АЛОЕ ВЕРА ГЕЛ СО АРОНИЈА 0,5Л', '2025@5.00: 135; 2026@5.00: 81; mex@5.00: 17'),
  ('d2be3ca6-3873-42a3-b07b-6ac2388c4541'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000110', 'АЛОЕ ВЕРА ГЕЛ- АРОНИЈА 1Л-сет2+1', '2025@5.00: 411; 2026@18.00: 1; 2026@5.00: 177'),
  ('d37e7cb6-5e7b-4c22-820f-a04a3ed1acc8'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000074', 'АЛОЕ ВЕРА ГЕЛ СО РЕСВЕРАТРОЛ 1Л', '2025@5.00: 56; 2026@5.00: 1; mex@5.00: 8'),
  ('d3930a77-916b-45a4-ae3d-f47739a6989d'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('d3e4dc26-5455-4f7e-b01d-a538d553daf6'::uuid, 0.050, 'sigma:by-name', '000503', 'БРОНХО ПРОТЕКТ 250ml', '2025@5.00: 392; 2026@5.00: 144; mex@5.00: 12'),
  ('d47ccca9-f0bc-4550-97ed-49ea890f78ce'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000524', 'СПИРУЛИНА 100 tbl', '2025@5.00: 4; mex@5.00: 3'),
  ('d4abf6fb-ffff-4613-a9b9-bdc538704d83'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000552', 'БРОНХО ПРОТЕКТ 500ml (сет 2+2)', 'no 2025–2026 sales invoice'),
  ('d4be8293-77b7-467f-b10f-6dddc7e2adfa'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000432', 'АПАРАТИ-(за притисок)', 'no 2025–2026 sales invoice'),
  ('d4d99132-315e-48fe-b448-ef2f45c497d3'::uuid, 0.050, 'rule:supplement-5', NULL, NULL, NULL),
  ('d5449c46-93ca-44e2-94d8-927465c97b91'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('d562b05f-8bf4-4dc2-b038-26c1ef2cd471'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('d5684d72-f24f-4a02-af02-49b5f5b44d9d'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '000949', 'АРТРО БЛУ ГЕЛ 200 МЛ', '2025@18.00: 82; 2026@0.00: 2; 2026@18.00: 29; mex@0.00: 2; mex@18.00: 16'),
  ('d5877b39-e763-449f-9d9e-3ee0a7f7a7fc'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000923', 'Л-КАРНИТИН  60 cps', '2025@5.00: 125; 2026@5.00: 59; mex@5.00: 13'),
  ('d6095095-29fd-42a0-9b9a-e112235baeb8'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001671', 'COLLAGEN & COCONUT WATER 200gr', '2026@5.00: 28'),
  ('d61c745a-0181-4a06-af06-6a521d6da868'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001339', 'СЕТ ЛАКСАТИВ', '2026@5.00: 4'),
  ('d65b038a-3779-4bed-9e61-2d4916259e9e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001584', 'ADENOFRIN 20/1 cps', '2026@0.00: 3; 2026@5.00: 9; mex@0.00: 2; mex@5.00: 3'),
  ('d672e4a2-2cf5-4089-9747-66d0452b1678'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002030', 'SOS флуид против акни', 'no 2025–2026 sales invoice'),
  ('d725515a-feea-4fdf-bddf-4e7403bb37a5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000461', 'ДИАБЕТОЛ ФОРТЕ 30cps (сет 2+1)', '2025@5.00: 93; 2026@5.00: 54'),
  ('d73f3812-dad1-4ff8-a32b-505809fd05ff'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('d7a1af2f-8228-4836-8dde-655883c3610c'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001303', 'СЕТ Д-маноза 60/1+УРО протект 60/1', '2025@5.00: 24'),
  ('d7ccc4c8-70a4-4393-9b5c-435a87976bfa'::uuid, 0.180, 'sigma:by-name+mixed', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('d822a096-b16f-44fd-b2f1-519022713c7a'::uuid, 0.050, 'sigma:by-name', '001088', '100% WHEY ВАНИЛА 500 гр', '2025@5.00: 256; 2026@5.00: 122; mex@5.00: 12'),
  ('d89d0473-8317-4214-b276-0d8ab9b49802'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000431', 'СТЕГАЧИ', 'no 2025–2026 sales invoice'),
  ('d8b0fbcb-fd01-4205-94de-c800425c182b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '600084', 'МАГНУМ КЛИМА УРЕД', '2025@18.00: 31'),
  ('d91cad1c-5041-43d2-b0b7-3a5901570c02'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000448', 'Вит.Ц за возрасни 0,5ml.', '2025@5.00: 101; 2026@0.00: 1; 2026@5.00: 39; mex@0.00: 1; mex@5.00: 13'),
  ('d932aa74-2f3c-4fdf-aa46-610864d16f2f'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002125', 'БАЗА ЗА ШМИНКА PRIME ME!', 'no 2025–2026 sales invoice'),
  ('d9aa8e45-1c04-4fee-b031-433759006fe1'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005005', 'ELIXY Серум со 20%снаил екстракт', '2025@18.00: 116; 2026@18.00: 33; mex@18.00: 11'),
  ('d9cc33fa-712e-4b81-ae31-2f750050ca35'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000957', 'БЦАА  во прав 200 гр.', '2025@5.00: 155; 2026@5.00: 152; mex@5.00: 14'),
  ('d9e5d5fd-f80f-4eca-bbe5-a07168caba5d'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001054', 'ВИТАМИН Ц-1000  60 cps', '2025@5.00: 185; 2026@5.00: 155; mex@5.00: 15'),
  ('daf37bb0-dbda-44da-a8fd-e1d14632710c'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('daf9023e-c5fd-4900-9160-6f430a6ac979'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001537', 'LIVERFIX BIONATURAL 30/1 cps', '2026@0.00: 1; 2026@5.00: 5; mex@5.00: 1'),
  ('db7970f9-8f37-4b63-8079-6ed2ff0c6423'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('dbda0620-af9a-479e-bcf2-a0ca7b2b0ec6'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '001048', 'Whey Чокол 1.5 +бцаа+креатин+л глутaми', 'no 2025–2026 sales invoice'),
  ('dcff0b93-8633-4140-b269-a2572f9bc13f'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001575', 'MAGNESIUM +ZINC+B complex 120/1tab', '2026@5.00: 159; mex@5.00: 5'),
  ('dd391aef-f536-4140-869a-935a83b337e3'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('dd849486-79b6-4901-922b-f8cb593dad39'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000742', 'БРАИН ПРОТЕКТ 30+30cps', '2025@5.00: 99; 2026@5.00: 25; mex@5.00: 2'),
  ('ddbb225d-3186-41c7-a079-61e8912de726'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000173', 'НИКОТИН ПРОТЕКТ 60 cps', 'no 2025–2026 sales invoice'),
  ('de3d548e-4665-49ea-bce9-49a8634bc60e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001023', 'Колаген Пептид со МАЛИНА 200 гр', '2025@5.00: 487; 2026@5.00: 312; mex@5.00: 17'),
  ('df7d4aa5-4179-420b-b5ec-05328bc00184'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002014', '100% масло од арган', 'no 2025–2026 sales invoice'),
  ('e0060d4e-946a-4ee9-9ba3-08ca5b49080a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001690', 'Dr Becker GlucoCare 20/1 cps', 'no 2025–2026 sales invoice'),
  ('e007acd2-7081-43fa-87d0-004f7f8528a3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001286', 'PROSTA FLOW 30 cps', 'no 2025–2026 sales invoice'),
  ('e06a89ca-dd08-4eda-80e1-7f42b4d19945'::uuid, 0.180, 'sigma:crosswalk-HIGH', '073377', 'ЕЛКТРИЧЕН БОКАЛ', 'no 2025–2026 sales invoice'),
  ('e07de6c2-a56f-473f-b97d-498d4c5ae8a3'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000528', 'БРОНХО ПРОТЕКТ 500ml (сет 2+1)', '2025@5.00: 261; 2026@5.00: 108'),
  ('e0a4c01f-f06b-4f49-98b3-f0de309f7992'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001316', 'BRAIN FIX BIONATURAL 30/1', '2026@5.00: 5; mex@5.00: 3'),
  ('e10ab6fc-eda4-47a8-9ddf-7a0536c603c4'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001229', 'НУТРИ ШЕЈК-со вкус на јагода 500 гр.', '2025@5.00: 212; 2026@5.00: 172; mex@5.00: 13'),
  ('e13d7a0a-bbda-43be-84bd-d7379f121f31'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001058', 'ХЕМОРО ФОРТЕ 30 cps', '2025@5.00: 127; 2026@5.00: 69; mex@5.00: 15'),
  ('e1dde82e-8b5e-4a4c-82af-984d789e04b3'::uuid, 0.050, 'sigma:by-name', '000503', 'БРОНХО ПРОТЕКТ 250ml', '2025@5.00: 392; 2026@5.00: 144; mex@5.00: 12'),
  ('e1e8601c-92f6-4b98-81ac-1fcf7dfb9e34'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('e20aeb02-14d1-40f1-9447-b18d45f2743b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005041', 'ELIXY -хидратантен серум 30 мл', '2025@18.00: 4; 2026@18.00: 7; mex@18.00: 1'),
  ('e22d849e-c5a7-4229-86a2-7d5f288175ae'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('e255dad4-846d-4920-9b84-424e6496b010'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001071', 'ПАРА ДЕТОКС 30 cps', '2025@5.00: 58; 2026@5.00: 31; mex@5.00: 13'),
  ('e25e349c-377e-45fb-9307-991573ac05ae'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001314', 'GLUCO FIX BIONATURAL30/1', '2025@5.00: 1; 2026@0.00: 3; 2026@5.00: 11; mex@0.00: 2; mex@5.00: 4'),
  ('e2f8329f-c971-46d9-afd4-6691bd14181b'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('e32ab114-9776-4fc7-9840-6e3ee236aebb'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074674', 'БОКАЛ-ФИЛТРИРАЊЕ', 'no 2025–2026 sales invoice'),
  ('e3b77e1b-29d9-4fdc-a65a-2aa857381e73'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('e45cd87d-2074-4b01-83a2-e96a3c013386'::uuid, 0.180, 'sigma:crosswalk-HIGH', '075903', 'ФИГАРО', 'no 2025–2026 sales invoice'),
  ('e48274ab-7855-43c5-9e05-b73836711363'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('e513e786-5292-4c11-916c-8306e8a83ddb'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001152', 'ВИТАМИН Д3 90 tbl', '2025@5.00: 153; 2026@5.00: 128; mex@5.00: 10'),
  ('e56c2be6-717c-4b27-8b7c-16b0d2a2a0c2'::uuid, 0.180, 'sigma:crosswalk-HIGH', '072599', 'РАЧЕН МИКСЕР', 'no 2025–2026 sales invoice'),
  ('e5a11614-77f7-4373-bf93-6e81eef9dccc'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000543', 'МЕГА МУЛТИВИТАМИН 250 мл.', '2025@5.00: 82; 2026@5.00: 26; mex@5.00: 10'),
  ('e5b5adaa-88a3-4891-9e19-e3943dcf9e9d'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000492', 'АЛОЕ СОК со вкус на лимон 500 ml', 'no 2025–2026 sales invoice'),
  ('e5f16536-aeff-476d-9841-9244a9827a1f'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('e63ee90d-7151-4902-b94e-7e4a49281040'::uuid, 0.050, 'sigma:by-name', '001335', 'TONGAKT ALI 60 cps', '2025@5.00: 26; 2026@5.00: 23; mex@5.00: 4'),
  ('e658f10e-8be7-4a60-8369-0a6667524ca1'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000461', 'ДИАБЕТОЛ ФОРТЕ 30cps (сет 2+1)', '2025@5.00: 93; 2026@5.00: 54'),
  ('e6c987a6-e637-4335-9ac7-53f978924d45'::uuid, 0.180, 'sigma:by-name+mixed', '005006', 'ELIXY-Ноќен крем снаил 50ml', '2025@18.00: 79; 2026@18.00: 44; mex@18.00: 8'),
  ('e6d9efcf-ddd4-4d01-8ad9-00cbed9e173c'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005019', 'ELIXY Серум со витамин Ц', '2025@18.00: 69; 2026@18.00: 21; mex@18.00: 7'),
  ('e801e327-a544-4b98-b9d3-a8cff600fecb'::uuid, 0.180, 'sigma:crosswalk-HIGH', '001641', 'MAGNESIUM GEL 50 ml', '2026@18.00: 86; mex@18.00: 2'),
  ('e8ac1aba-9027-4a6d-a7f8-f8156f86809c'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('eaa75b4e-92ff-4f37-8001-c828db96a8a1'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000585', 'БЈУТИ КОЛАГЕН 500мл', '2025@5.00: 256; 2026@5.00: 105; mex@5.00: 13'),
  ('eb9a2bd0-0b2b-4b06-a679-5b1040122370'::uuid, 0.180, 'sigma:by-name', '005006', 'ELIXY-Ноќен крем снаил 50ml', '2025@18.00: 79; 2026@18.00: 44; mex@18.00: 8'),
  ('ebc8abe6-cef3-4455-bea9-0a78f31f96e4'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001185', 'Сет Турмерик 2+1 Неуроактив', '2025@5.00: 63'),
  ('ecb31fdc-6224-44bd-857b-648b78a0694c'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000503', 'БРОНХО ПРОТЕКТ 250ml', '2025@5.00: 392; 2026@5.00: 144; mex@5.00: 12'),
  ('ee243b7e-b117-4951-b5e3-963127c8488b'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('ee2ef09d-dd2d-473e-90c8-23153f6ae078'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '072599', 'РАЧЕН МИКСЕР', 'no 2025–2026 sales invoice'),
  ('ee6b9219-3136-414c-9146-9dbe92b7cb59'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000030', 'ГАСТРО КОМПЛЕКС 250 мл. сет (2+1)', 'no 2025–2026 sales invoice'),
  ('ef083553-1010-4d97-b7e5-e8e3517f14e8'::uuid, 0.180, 'sigma:crosswalk-HIGH', '002343', 'Витамин Ц серум 30мл', 'no 2025–2026 sales invoice'),
  ('ef144b8f-e4bb-4645-8b6e-febf9eef3953'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('efc6db90-4fcd-42c3-8e71-e593d0d590fd'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('effc5cf2-ebfb-45c4-95ff-dcfc9bc7e5df'::uuid, 0.180, 'rule:device-18', NULL, NULL, NULL),
  ('f0a77b56-99dd-44af-979c-fda3020f50e4'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('f10a2c9e-e3e6-4f31-bc7d-0b191cdff2d5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001661', 'VITAMIN D3 120/1 tab', '2026@5.00: 73'),
  ('f12c1064-6b77-486c-8eb0-11f1bc5b3014'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000432', 'АПАРАТИ-(за притисок)', 'no 2025–2026 sales invoice'),
  ('f1968b8f-aa4a-43f3-a0e8-c2d9a815a8c1'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('f2bf2121-882e-4703-9a3b-a9b7cc4b67a7'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000760', 'ХОЛЕСТОЛ КОМПЛЕКС СЕТ (2+1)', '2025@5.00: 65; 2026@5.00: 30'),
  ('f2d8ab1e-9ee2-42e4-8736-cae2c1a305e1'::uuid, 0.180, 'sigma:crosswalk-HIGH', '005011', 'ELIXY Масло од јојоба 30 ml', '2025@18.00: 35; 2026@18.00: 20; mex@18.00: 7'),
  ('f3303545-5dca-4c1f-a64e-a0bb1eb79384'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('f34b4478-c07a-4830-b7cb-34e74bcd773e'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001250', 'ПРОТЕИНСКИ СЛАДОЛЕД ВАНИЛА 200 гр', '2025@5.00: 35; 2026@5.00: 68; mex@5.00: 3'),
  ('f34c3188-7588-4532-9f10-ab31f5abf20a'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000553', 'АЛОЕ ВЕРА ГЕЛ -АРОНИЈА 1Л-сет2+2', 'no 2025–2026 sales invoice'),
  ('f34ede78-3084-429a-9e4b-bc9285eddddc'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('f454ae1b-e84f-4de7-b5d2-1846dde9884a'::uuid, 0.180, 'sigma:crosswalk-HIGH', '076756', 'МОБИЛЕН ТЕЛЕФОН', 'no 2025–2026 sales invoice'),
  ('f4dd57ca-06c1-4641-ad3c-7723f5646415'::uuid, 0.180, 'sigma:crosswalk-HIGH', '075551', 'Стапчеста правосмикалка 2во1', 'no 2025–2026 sales invoice'),
  ('f4e2c96b-571d-4620-bbf5-097fed5fe026'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001112', 'Колаген Пептид -ЧОКОЛАДО 200 гр', '2025@5.00: 180; 2026@5.00: 61; mex@5.00: 12'),
  ('f53e82a0-63d7-423c-bd76-68d6cc772f12'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('f569db4a-3b64-4bcb-b962-461c39af14f6'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000439', 'ТПE ЈОГА МАТ (мрежа)', 'no 2025–2026 sales invoice'),
  ('f56cf65b-f069-4a4f-b302-d40bd93f3664'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000953', 'КРЕАТИН во прав  200 гр.', '2025@5.00: 404; 2026@5.00: 741; mex@5.00: 14'),
  ('f5e7af71-357a-4186-86fd-d7568fcb9b8d'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000893', 'ДИЕТ ШЕЈК Јагода 500g', '2025@5.00: 225; 2026@5.00: 198; mex@5.00: 13'),
  ('f5ee28d2-b839-4cb2-888e-d37d6f664756'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000305', 'СПИРУЛИНА КАПСУЛИ cps 60- (600мг)', 'no 2025–2026 sales invoice'),
  ('f6e635de-b1d0-4d07-9ddc-9a6c21d0d5cb'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('f775838c-a4fc-4eb2-b83e-9728a2f4cbd5'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001319', '100% WHEY ЧОКОЛАДО 2000 гр', '2025@5.00: 72; 2026@5.00: 154; mex@5.00: 3'),
  ('f8973223-d7d6-4c5a-8086-a675e9f51c46'::uuid, 0.180, 'sigma:crosswalk-MEDIUM', '002056', 'ШАМП.ПРОТИВ ОПАЃАЊЕ 250мл', 'no 2025–2026 sales invoice'),
  ('f95e138b-9176-4b24-a348-d667821a7766'::uuid, 0.180, 'sigma:crosswalk-HIGH', '074764', 'АПАР.ПРОТИВ ИНСЕКТИ', 'no 2025–2026 sales invoice'),
  ('f960872c-8a5c-4ae5-a4aa-496fc2b43f3e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000412', 'ДИАБЕТОЛ ФОРТЕ 30cps', '2025@5.00: 180; 2026@5.00: 114; mex@5.00: 18'),
  ('f9b50d61-846b-47e4-9e3b-fea57ac37213'::uuid, 0.180, 'sigma:by-name+mixed', '005007', 'ELIXY-Дневенкрем снаил 50ml', '2025@18.00: 118; 2026@18.00: 67; mex@18.00: 12'),
  ('f9efaf2a-84ba-49f6-9de0-b9d859f8665e'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000565', 'ГАСТРО АЛОЕ 500ml', '2025@5.00: 375; 2026@5.00: 160; mex@5.00: 18'),
  ('faa45e27-43c2-4f74-9315-b74bece42e1c'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '000325', 'ЕПИМЕДИУМ КОМПЛЕКС 30 cps.', '2025@5.00: 43; 2026@5.00: 19; mex@5.00: 16'),
  ('fae40061-d8ad-4025-9de0-3dea17daff71'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001538', 'UROFIX BIONATURAL 30/1', '2026@0.00: 3; 2026@5.00: 10; mex@0.00: 2; mex@5.00: 3'),
  ('faea7453-4c63-4345-9d11-d6a181a75346'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001232', 'БИЛБЕРИ 90/1 таблети', '2025@5.00: 30; 2026@5.00: 27; mex@5.00: 8'),
  ('fb450a97-8fde-4591-99d5-83b3caa7ce93'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001527', 'ВИТАМИН Д3 365/1 таб', '2026@5.00: 84; mex@5.00: 2'),
  ('fb4bb034-2581-44f3-a762-272c76829bca'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000021', 'ГАСТРО КОМПЛЕКС 250  мл.', 'no 2025–2026 sales invoice'),
  ('fc3566f6-f4dd-48bc-a6eb-274d431acd25'::uuid, 0.180, 'sigma:crosswalk-HIGH', '000906', 'СЛИМ БОКС ПАКЕТ', '2025@18.00: 3'),
  ('fc5f7a6d-2741-4f60-9f03-efb81023e260'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000398', 'ХЕПАТОЛ ФОРТЕ 30cps-сет 2+1', '2025@5.00: 49; 2026@5.00: 23'),
  ('fd3c0b83-a19a-4f03-8096-c591fa8b287b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001670', 'ZINC 120/1 tab', '2026@5.00: 66'),
  ('fd939174-e55c-4d3e-8d3a-1bf764a3329b'::uuid, 0.180, 'sigma:crosswalk-HIGH', '071523', 'ТЕЛЕСНА ВАГА', 'no 2025–2026 sales invoice'),
  ('fe03758d-94fa-44cf-bd04-2f2f693ba13b'::uuid, 0.180, 'rule:cosmetic-18', NULL, NULL, NULL),
  ('fe0dcdc0-b45e-40f8-a159-58ee2dda3d7d'::uuid, 0.050, 'sigma:crosswalk-MEDIUM', '000957', 'БЦАА  во прав 200 гр.', '2025@5.00: 155; 2026@5.00: 152; mex@5.00: 14'),
  ('fe262460-3161-4b43-b948-d386d14a34d8'::uuid, 0.180, 'sigma:crosswalk-VERIFIED', '005008', 'ELIXY-Околуочен крем 30ml', '2025@18.00: 63; 2026@18.00: 23; mex@18.00: 10'),
  ('fe3b68cf-26df-4883-8cc8-4c0750b79da0'::uuid, 0.050, 'sigma:crosswalk-HIGH', '000199', 'НОНИ ЕКСТРАКТ 0,5Л (сет 2+1)', 'no 2025–2026 sales invoice'),
  ('fe3d1bf9-67ba-40ab-ab7e-7e341bd3d6ed'::uuid, 0.050, 'sigma:crosswalk-VERIFIED', '001230', 'ДР.СЛИМ РАСТИТЕЛЕН 210 гр', '2025@5.00: 58; 2026@0.00: 1; 2026@5.00: 58; mex@0.00: 1; mex@5.00: 11'),
  ('ffbb183b-a44c-412a-bebb-512ad0bd5e6b'::uuid, 0.050, 'sigma:crosswalk-HIGH', '001693', 'Dr Becker MenCare 20/1 cps', 'no 2025–2026 sales invoice');
-- <<< END GENERATED

DO $backfill$
DECLARE
  v_rows int;
  v_missing int;
  v_done int;
BEGIN
  SELECT count(*) INTO v_rows FROM vat_backfill;
  IF v_rows <> 706 THEN
    RAISE EXCEPTION 'product VAT backfill: expected 706 rows, got %', v_rows;
  END IF;
  IF EXISTS (SELECT 1 FROM vat_backfill WHERE rate NOT IN (0, 0.05, 0.10, 0.18)) THEN
    RAISE EXCEPTION 'product VAT backfill: a rate outside 0 / 5 / 10 / 18 %%';
  END IF;
  SELECT count(*) INTO v_missing FROM vat_backfill b WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = b.id);
  IF v_missing > 0 THEN
    RAISE NOTICE 'product VAT backfill: % product(s) of the 01.10 table no longer exist — skipped', v_missing;
  END IF;

  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.vat_rate_write', 'on', true);
  UPDATE public.products p
     SET vat_rate = b.rate, vat_source = b.source, vat_sigma_code = b.sigma_code, vat_sigma_name = b.sigma_name,
         vat_evidence = b.evidence, vat_set_by = NULL, vat_set_at = now()
    FROM vat_backfill b
   WHERE b.id = p.id AND p.vat_rate IS NULL;
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('elyon.vat_rate_write', 'off', true);
  PERFORM set_config('elyon.keep_updated_at', 'off', true);
  RAISE NOTICE 'product VAT backfill: % products set (% at 5 %%, % at 18 %%)', v_done,
    (SELECT count(*) FROM public.products WHERE vat_rate = 0.05), (SELECT count(*) FROM public.products WHERE vat_rate = 0.18);
END
$backfill$;

-- ── 6. the cache: a changed rate invalidates it; nothing cached with the flat 18 % is merged ──────
CREATE OR REPLACE FUNCTION public.insights_profit_cache_sig()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT md5(
    coalesce((SELECT string_agg(p.id::text || '|' || coalesce(p.name, '') || '|' || coalesce(p.cost_price::text, '')
                                || '|' || coalesce(p.vat_rate::text, ''), ';' ORDER BY p.id)
                FROM public.products p), '') || '#' ||
    coalesce((SELECT string_agg(a.source || '|' || a.alias_norm || '|' || coalesce(a.product_id::text, '') || '|' || a.kind, ';'
                                ORDER BY a.source, a.alias_norm)
                FROM public.product_aliases a), '') || '#' ||
    coalesce(array_to_string(public.report_excluded_phone8s(), ','), ''))
$function$;

-- 4 → 5: per-product VAT (20260944000900)
CREATE OR REPLACE FUNCTION public.insights_profit_cache_version()
 RETURNS integer
 LANGUAGE sql
 IMMUTABLE
AS $function$ SELECT 5 $function$;

-- ── 7. insights_profit(): VAT per line ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.insights_profit(p_from timestamp with time zone, p_to_end timestamp with time zone, p_clock text DEFAULT 'cohort'::text, p_granularity text DEFAULT NULL::text, p_detail boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET "TimeZone" TO 'UTC'
 SET work_mem TO '64MB'
 SET jit TO 'off'
AS $function$
DECLARE
  -- $1 from · $2 to_end · $3 granularity ('day' | 'month') · $4 detail
  v_head_cohort text := $hc$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE sale cohort (insights_sale_rows), each sale's group:
--   collected = paid (MEX delivered) + paid_legacy · returned · open (courier,
--   problem, label, to pack) · unproven (CRM paid, no parcel — never profit)
sr AS MATERIALIZED (
  SELECT r.kind, r.source, r.bucket, r.in_total, r.value_mkd, r.cod_mkd, r.card_mkd, r.sale_day,
         r.order_id, r.web_id, r.tracking_id, r.q_shared_parcel,
         CASE WHEN r.bucket IN ('paid', 'paid_legacy') THEN 'collected'
              WHEN r.bucket = 'returned'               THEN 'returned'
              WHEN r.bucket = 'paid_unproven'          THEN 'unproven'
              WHEN r.in_total                          THEN 'open' END AS g
  FROM public.insights_sale_rows($1, $2, false) r
),
-- a parcel two orders share (owner-ruled accurate) is ONE parcel to MEX: each
-- holder carries 1/holders of it — counted over ALL its holders (the
-- foundation's rule: real, non-test orders), not only those in the window,
-- so any split of a window into pieces adds up to the same parcels
shp AS (
  SELECT x.mex_tracking_id AS tracking_id, count(*) AS c
  FROM public.orders x
  WHERE x.mex_tracking_id IN (SELECT sr.tracking_id FROM sr WHERE sr.q_shared_parcel AND sr.tracking_id IS NOT NULL)
    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
    AND NOT public.insights_excluded8(public.insights_phone8(x.customer_phone), (SELECT public.report_excluded_phone8s()))
  GROUP BY 1
),
s0 AS (
  SELECT sr.g, sr.source, sr.kind,
         coalesce(sr.value_mkd, 0)::float8 AS rev, coalesce(sr.card_mkd, 0)::float8 AS card,
         sr.sale_day AS day, sr.order_id, sr.web_id, sr.tracking_id,
         CASE WHEN shp.c > 1 THEN 1.0::float8 / shp.c ELSE 1.0::float8 END AS pw
  FROM sr LEFT JOIN shp ON shp.tracking_id = sr.tracking_id AND sr.q_shared_parcel
  WHERE sr.g IS NOT NULL
),
$hc$;
  v_head_cash text := $hh$
WITH
prm AS (
  SELECT $1::timestamptz AS f, $2::timestamptz AS t, $3::text AS gran,
         CASE WHEN $3::text = 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END AS fmt
),
-- THE cash flow (insights_cash_rows): every MEX parcel delivered in the
-- window, once, with its owner; revenue = COD + the card money of a
-- card-paid web order
s0 AS (
  SELECT 'collected'::text AS g, c.source, c.kind,
         (coalesce(c.cod_mkd, 0) + coalesce(c.card_mkd, 0))::float8 AS rev,
         coalesce(c.card_mkd, 0)::float8 AS card,
         (c.delivered_at AT TIME ZONE 'Europe/Skopje')::date AS day,
         c.order_id, c.web_id, c.tracking_id, 1.0::float8 AS pw
  FROM public.insights_cash_rows($1, $2) c
),
$hh$;
  v_common text := $cm$
s1 AS MATERIALIZED (
  SELECT row_number() OVER () AS sid, s0.*,
         to_char(date_trunc(prm.gran, s0.day::timestamp), prm.fmt) AS d
  FROM s0 CROSS JOIN prm
),
oid AS MATERIALIZED (SELECT DISTINCT s1.order_id AS id FROM s1 WHERE s1.order_id IS NOT NULL),
oi AS MATERIALIZED (
  SELECT i.order_id, i.product_id, i.product_name,
         coalesce(i.quantity, 0) AS qty,
         coalesce(i.price_per_unit, 0)::float8 AS ppu,
         coalesce(i.total_price, 0)::float8 AS tp
  FROM public.order_items i JOIN oid ON oid.id = i.order_id
),
oia AS (
  SELECT oi.order_id,
         sum((CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty) AS bonus_items
  FROM oi GROUP BY 1
),
-- index.ts orderPackageBonus(), unchanged: EUR per package by the line's
-- unit price (<25 → 1 · 25–35 → 2 · ≥35 → 3), only when status = 'paid';
-- an order with no lines prices its own quantity. The owner (ownerOf()
-- before normAgent) goes out raw: the api applies the agents-only gate.
ob AS MATERIALIZED (
  SELECT x.id, x.status::text AS status, x.sale_source, x.product_id, x.product_name,
         coalesce(x.confirmed_by_name, x.assigned_agent_name) AS owner_raw,
         nullif(btrim(x.cpa_webmaster_id), '') AS wm,
         (a.order_id IS NOT NULL) AS has_items,
         CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END AS oq,
         CASE WHEN x.status::text <> 'paid' THEN 0
              WHEN a.order_id IS NOT NULL THEN coalesce(a.bonus_items, 0)
              ELSE (CASE WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 >= 35 THEN 3
                         WHEN coalesce(x.price, 0)::float8
                                / (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)::float8 > 25 THEN 2
                         ELSE 1 END)
                   * (CASE WHEN coalesce(x.quantity, 0) = 0 THEN 1 ELSE x.quantity END)
         END::float8 AS bonus_eur
  FROM public.orders x
  JOIN oid ON oid.id = x.id
  LEFT JOIN oia a ON a.order_id = x.id
),
s AS MATERIALIZED (
  SELECT s1.*, ob.owner_raw, ob.status AS crm_status,
         CASE WHEN s1.source = 'altercpa' THEN coalesce(ob.wm, '__none__') END AS wm,
         coalesce(ob.bonus_eur, 0) AS bonus_eur
  FROM s1 LEFT JOIN ob ON ob.id = s1.order_id
),
-- every P&L sale's lines (collected + returned); a sale with none gets one
-- pseudo line so its revenue is never dropped
ln0 AS MATERIALIZED (
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_name AS name, oi.product_id AS pid, oi.qty,
         CASE WHEN oi.ppu > 0 THEN oi.ppu * greatest(oi.qty, 0) WHEN oi.tp > 0 THEN oi.tp ELSE 0 END::float8 AS w0,
         CASE WHEN ob.status = 'paid'
              THEN (CASE WHEN oi.ppu >= 35 THEN 3 WHEN oi.ppu > 25 THEN 2 ELSE 1 END) * oi.qty ELSE 0 END::float8 AS lb,
         NULL::text AS wkind
  FROM s JOIN ob ON ob.id = s.order_id JOIN oi ON oi.order_id = s.order_id
  WHERE s.g IN ('collected', 'returned')
  UNION ALL
  SELECT s.sid, CASE WHEN ob.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END,
         ob.product_name, ob.product_id, ob.oq, 1::float8, ob.bonus_eur, NULL
  FROM s JOIN ob ON ob.id = s.order_id
  WHERE s.g IN ('collected', 'returned') AND NOT ob.has_items
  UNION ALL
  -- web_order_items joined straight (its index), never through a CTE: the
  -- planner cannot size a CTE and loops over it once per web sale
  SELECT s.sid, 'web', wi.name, NULL::uuid, coalesce(wi.quantity, 0),
         CASE WHEN wi.kind = 'GIFT' THEN 0
              ELSE greatest(coalesce(wi.price, 0) * coalesce(wi.quantity, 0) - coalesce(wi.discount_allocated, 0), 0) END::float8,
         0::float8, wi.kind
  FROM s JOIN public.web_order_items wi ON wi.shop_order_id = s.web_id
  WHERE s.g IN ('collected', 'returned') AND s.kind = 'web'
  UNION ALL
  SELECT s.sid, CASE WHEN s.kind = 'mex' THEN 'mex' ELSE 'none' END, NULL, NULL, 0, 1::float8, 0::float8, NULL
  FROM s
  WHERE s.g IN ('collected', 'returned')
    AND (s.kind = 'mex'
         OR (s.kind = 'web' AND NOT EXISTS (SELECT 1 FROM public.web_order_items wi WHERE wi.shop_order_id = s.web_id)))
),
-- the catalogue by its folded name (product_alias_norm): an exact name match
-- (case / spaces ignored) IS that catalogue product; spelling variants still
-- wait for reviewed product_aliases rows
cat AS (
  SELECT DISTINCT ON (public.product_alias_norm(p.name))
         public.product_alias_norm(p.name) AS nn, p.id
  FROM public.products p
  WHERE public.product_alias_norm(p.name) IS NOT NULL
  ORDER BY public.product_alias_norm(p.name), (coalesce(p.cost_price, 0) > 0) DESC, p.is_active DESC, p.created_at, p.id
),
-- keys and kinds once per distinct line (product_key() is not inlinable)
lk AS MATERIALIZED (
  SELECT d.src, d.pk_name, d.pk_pid, k.key0, k.nn, k.rk
  FROM (SELECT DISTINCT ln0.src, ln0.name, ln0.pid,
               coalesce(ln0.name, '') AS pk_name, coalesce(ln0.pid::text, '') AS pk_pid
          FROM ln0 WHERE ln0.src IN ('crm', 'collabbox', 'web')) d
  CROSS JOIN LATERAL (
    SELECT public.product_key(d.src, d.name, d.pid) AS key0,
           public.product_alias_norm(d.name) AS nn,
           (SELECT a.kind FROM public.product_aliases a
             WHERE a.source IN (d.src, 'any') AND a.alias_norm = public.product_alias_norm(d.name)
             ORDER BY (a.source = d.src) DESC LIMIT 1) AS rk
  ) k
),
lk2 AS MATERIALIZED (
  SELECT lk.src, lk.pk_name, lk.pk_pid,
         CASE WHEN lk.key0 LIKE 'p:%' THEN lk.key0
              WHEN cat.id IS NOT NULL THEN 'p:' || cat.id::text
              ELSE coalesce(lk.key0, '__unknown__') END AS k,
         -- a reviewed alias decides; until then the obvious non-product lines
         -- of the collabBox / CRM imports are recognised by their name
         coalesce(lk.rk,
           CASE WHEN lk.nn ~ '^(поен|poen)'          THEN 'loyalty_point'
                WHEN lk.nn ~ '^(достав|dostav)'      THEN 'delivery'
                WHEN lk.nn ~ '^(забелешк|zabeles)'   THEN 'note'
                WHEN lk.nn ~ '^(флаер|flaer|flyer)'  THEN 'flyer' END) AS kind0,
         (lk.rk IS NOT NULL) AS reviewed
  FROM lk LEFT JOIN cat ON cat.nn = lk.nn AND lk.key0 NOT LIKE 'p:%'
),
-- a known cost is a catalogue cost_price > 0 (EUR) — never invented; the VAT
-- rate is the product's own (products.vat_rate, from Sigma; NULL = unclassified)
kc AS (
  SELECT DISTINCT ON (k2.k) k2.k, CASE WHEN p.cost_price > 0 THEN p.cost_price::numeric END AS cost_eur, p.name AS pname,
         p.vat_rate AS vat_n
  FROM lk2 k2 JOIN public.products p ON k2.k = 'p:' || p.id::text
  ORDER BY k2.k
),
ln1 AS (
  SELECT ln0.sid, ln0.name, ln0.qty, ln0.w0, ln0.lb,
         CASE WHEN ln0.src = 'mex' THEN '__mex_only__' WHEN ln0.src = 'none' THEN '__unknown__'
              ELSE coalesce(k2.k, '__unknown__') END AS k,
         CASE WHEN ln0.src IN ('mex', 'none') THEN 'unknown'
              ELSE coalesce(k2.kind0, CASE WHEN ln0.wkind = 'GIFT' THEN 'gift' END, 'product') END AS kind,
         coalesce(k2.reviewed, false) AS reviewed,
         kc.cost_eur::float8 AS cost_eur, kc.pname, kc.vat_n
  FROM ln0
  LEFT JOIN lk2 k2 ON k2.src = ln0.src AND k2.pk_name = coalesce(ln0.name, '') AND k2.pk_pid = coalesce(ln0.pid::text, '')
  LEFT JOIN kc ON kc.k = k2.k
),
-- per sale: the weights its value is split by
ls AS (
  SELECT ln1.sid, sum(ln1.w0) AS sw,
         sum(CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty ELSE 0 END) AS sq,
         count(*) AS nl,
         count(*) FILTER (WHERE ln1.kind IN ('product', 'gift')) AS np
  FROM ln1 GROUP BY 1
),
ln AS (
  SELECT ln1.sid, ln1.k, ln1.kind, ln1.reviewed, (ln1.kind IN ('product', 'gift')) AS pkg,
         ln1.qty, ln1.lb, ln1.cost_eur, ln1.vat_n,
         coalesce(ln1.pname, ln1.name) AS name,
         s.g, s.source, s.d, s.wm,
         -- the sale's value by price weight; all-zero prices → by packages
         s.rev * (CASE WHEN ls.sw > 0 THEN ln1.w0 / ls.sw
                       WHEN ls.sq > 0 THEN (CASE WHEN ln1.kind IN ('product', 'gift') THEN ln1.qty::float8 / ls.sq ELSE 0 END)
                       ELSE 1.0::float8 / ls.nl END) AS rv,
         -- the sale's parcel by packages (courier share)
         s.pw * (CASE WHEN ls.np = 0 THEN 1.0::float8 / ls.nl
                      WHEN ln1.kind NOT IN ('product', 'gift') THEN 0
                      WHEN ls.sq > 0 THEN ln1.qty::float8 / ls.sq
                      ELSE 1.0::float8 / ls.np END) AS sh,
         (ln1.kind IN ('product', 'gift') AND ls.sw > 0 AND ln1.w0 = 0) AS free
  FROM ln1 JOIN ls ON ls.sid = ln1.sid JOIN s ON s.sid = ln1.sid
),
lm AS MATERIALIZED (     -- line measures (денари; cost EUR × 61,5)
  SELECT ln.*,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.rv ELSE 0 END AS rc,
         CASE WHEN (ln.pkg AND ln.cost_eur IS NULL) OR ln.kind = 'unknown' THEN ln.rv ELSE 0 END AS ru,
         CASE WHEN NOT ln.pkg AND ln.kind <> 'unknown' THEN ln.rv ELSE 0 END AS rn,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.cost_eur * ln.qty * 61.5 ELSE 0 END AS cm,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL THEN ln.qty ELSE 0 END AS pc,
         CASE WHEN ln.pkg AND ln.cost_eur IS NULL THEN ln.qty ELSE 0 END AS pu,
         CASE WHEN ln.free THEN ln.qty ELSE 0 END AS fr,
         -- VAT per LINE (owner 01.10.2026, replaces the flat 18 %): the line's
         -- value × r/(1+r), r = its product's Sigma rate. A line with no product
         -- or no rate (a MEX-only parcel, a sale without lines, an unmatched
         -- name, a product not classified yet) is taxed at the core range's 5 %
         -- and its value is counted in vu — visible, never silent.
         coalesce(ln.vat_n, 0.05) AS vr,
         (ln.vat_n IS NULL) AS vd,
         ln.rv * coalesce(ln.vat_n, 0.05)::float8 / (1 + coalesce(ln.vat_n, 0.05)::float8) AS vt,
         CASE WHEN ln.pkg AND ln.cost_eur IS NOT NULL
              THEN ln.rv * coalesce(ln.vat_n, 0.05)::float8 / (1 + coalesce(ln.vat_n, 0.05)::float8) ELSE 0 END AS vc,
         CASE WHEN ln.vat_n IS NULL THEN ln.rv ELSE 0 END AS vu,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0    THEN ln.rv ELSE 0 END AS v00,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.05 THEN ln.rv ELSE 0 END AS v05,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.10 THEN ln.rv ELSE 0 END AS v10,
         CASE WHEN coalesce(ln.vat_n, 0.05) = 0.18 THEN ln.rv ELSE 0 END AS v18
  FROM ln
),
agg_s AS (    -- sale-level measures
  SELECT s.g, s.source, s.d, s.wm, count(*) AS n, sum(s.rev) AS rev, sum(s.card) AS card, sum(s.pw) AS pw
  FROM s GROUP BY GROUPING SETS ((s.g, s.source), (s.g, s.d), (s.g, s.wm))
),
agg_l AS (    -- line measures on the same grains
  SELECT lm.g, lm.source, lm.d, lm.wm,
         sum(lm.rc) AS rc, sum(lm.ru) AS ru, sum(lm.rn) AS rn, sum(lm.cm) AS cm,
         sum(lm.pc) AS pc, sum(lm.pu) AS pu, sum(lm.fr) AS fr, sum(lm.lb) AS lb,
         sum(lm.vt) AS vt, sum(lm.vc) AS vc, sum(lm.vu) AS vu,
         sum(lm.v00) AS v00, sum(lm.v05) AS v05, sum(lm.v10) AS v10, sum(lm.v18) AS v18
  FROM lm GROUP BY GROUPING SETS ((lm.g, lm.source), (lm.g, lm.d), (lm.g, lm.wm))
),
agg AS (
  SELECT a.g,
         CASE WHEN a.source IS NOT NULL THEN 's' WHEN a.d IS NOT NULL THEN 'd' ELSE 'w' END AS dim,
         coalesce(a.source, a.d, a.wm) AS key,
         -- 9 decimals: a month-by-month cache adds up to the whole window exactly once rounded to denars
         a.n, round(a.rev::numeric, 9) AS rev, round(a.card::numeric, 9) AS card, round(a.pw::numeric, 9) AS pw,
         round(coalesce(l.rc, 0)::numeric, 9) AS rc, round(coalesce(l.ru, 0)::numeric, 9) AS ru, round(coalesce(l.rn, 0)::numeric, 9) AS rn,
         round(coalesce(l.cm, 0)::numeric, 9) AS cm, coalesce(l.pc, 0) AS pc, coalesce(l.pu, 0) AS pu,
         coalesce(l.fr, 0) AS fr, coalesce(l.lb, 0)::numeric AS lb,
         -- VAT per line (vt), of the costed part (vc), the unclassified value (vu)
         -- and the value by rate (v00 / v05 / v10 / v18; vu is inside v05)
         round(coalesce(l.vt, 0)::numeric, 9) AS vt, round(coalesce(l.vc, 0)::numeric, 9) AS vc,
         round(coalesce(l.vu, 0)::numeric, 9) AS vu,
         round(coalesce(l.v00, 0)::numeric, 9) AS v00, round(coalesce(l.v05, 0)::numeric, 9) AS v05,
         round(coalesce(l.v10, 0)::numeric, 9) AS v10, round(coalesce(l.v18, 0)::numeric, 9) AS v18
  FROM agg_s a
  LEFT JOIN agg_l l ON l.g = a.g
       AND coalesce(l.source, '') = coalesce(a.source, '') AND coalesce(l.d, '') = coalesce(a.d, '')
       AND coalesce(l.wm, '') = coalesce(a.wm, '')
  WHERE a.source IS NOT NULL OR a.d IS NOT NULL OR a.wm IS NOT NULL
),
comm AS (     -- today's per-package bonus of every paid order, at owner grain
  SELECT s.source, s.d, s.wm, s.owner_raw, sum(s.bonus_eur)::numeric AS b, count(*) AS n
  FROM s WHERE s.g = 'collected' AND s.bonus_eur > 0
  GROUP BY GROUPING SETS ((s.source, s.owner_raw), (s.d, s.owner_raw), (s.wm, s.owner_raw))
),
wmn AS (
  SELECT DISTINCT ON (w.wm_id) w.wm_id, w.name
  FROM public.altercpa_webmasters w
  WHERE nullif(btrim(w.name), '') IS NOT NULL
  ORDER BY w.wm_id, w.named_at DESC NULLS LAST, w.updated_at DESC
),
$cm$;
  v_tail_cohort text := $tc$
cb AS (       -- the cohort strip: Σ = insights_cohort, bucket by bucket
  SELECT sr.source AS s, sr.bucket AS b, count(*) AS n,
         round(coalesce(sum(sr.value_mkd), 0)) AS v,
         round(coalesce(sum(sr.cod_mkd), 0))   AS c,
         count(*) FILTER (WHERE sr.kind = 'order') AS no,
         count(*) FILTER (WHERE sr.kind = 'web')   AS nw,
         count(*) FILTER (WHERE sr.kind = 'mex')   AS nm,
         count(*) FILTER (WHERE sr.kind = 'booking') AS nb
  FROM sr GROUP BY 1, 2
),
pn AS (       -- how many sales carry the product (a narrow hash, no DISTINCT sort)
  SELECT x.source, x.g, x.k, count(*) AS n
  FROM (SELECT lm.source, lm.g, lm.k, lm.sid FROM lm GROUP BY 1, 2, 3, 4) x
  GROUP BY 1, 2, 3
),
prod AS (     -- the product P&L (collected and returned), by source
  SELECT lm.source AS s, lm.g, lm.k,
         -- byte order (COLLATE "C"): the api folds pieces with the same rule
         min(lm.name COLLATE "C") AS name, min(lm.kind COLLATE "C") AS kind, bool_or(lm.reviewed) AS reviewed,
         bool_or(lm.pkg) AS pkg, max(lm.cost_eur) AS cost_eur, max(pn.n) AS n,
         sum(lm.qty) AS qty, sum(CASE WHEN lm.pkg THEN lm.qty ELSE 0 END) AS pkgs, sum(lm.fr) AS fr,
         round(sum(lm.rv)::numeric, 9) AS rev, round(sum(lm.cm)::numeric, 9) AS cm,
         round(sum(lm.sh)::numeric, 9) AS sh, sum(lm.lb)::numeric AS lb,
         -- the product's VAT (Σ per line), its rate, whether the rate was defaulted
         round(sum(lm.vt)::numeric, 9) AS vt, max(lm.vr) AS vr, bool_or(lm.vd) AS vd
  FROM lm JOIN pn ON pn.source = lm.source AND pn.g = lm.g AND pn.k = lm.k
  GROUP BY 1, 2, 3
),
pd AS (       -- realized денари per paid package (collected, real products), binned to the denar
  SELECT lm.source AS s, round(lm.rv / lm.qty)::int AS u, sum(lm.qty) AS q, sum(lm.rv) AS v
  FROM lm
  WHERE lm.g = 'collected' AND lm.pkg AND NOT lm.free AND lm.qty > 0 AND lm.rv > 0
  GROUP BY 1, 2
)
SELECT jsonb_build_object(
  'clock', 'cohort',
  -- every agg row carries vt / vc / vu / v00–v18 and every product row vt / vr / vd
  'vat_mode', 'per_line',
  'granularity', (SELECT gran FROM prm),
  'strip', coalesce((SELECT jsonb_agg(to_jsonb(cb) ORDER BY cb.s, cb.b) FROM cb), '[]'::jsonb),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'products', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(to_jsonb(prod) ORDER BY prod.rev DESC, prod.k) FROM prod), '[]'::jsonb) END,
  'hist', CASE WHEN $4 THEN coalesce((SELECT jsonb_agg(jsonb_build_object('s', pd.s, 'u', pd.u, 'q', pd.q, 'v', round(pd.v::numeric, 9))) FROM pd), '[]'::jsonb) END,
  'no_items', (SELECT jsonb_build_object('n', count(*), 'v', round(coalesce(sum(s.rev), 0)))
                 FROM s JOIN ob ON ob.id = s.order_id
                WHERE s.g = 'collected' AND NOT ob.has_items)
)
$tc$;
  v_tail_cash text := $th$
xp AS MATERIALIZED (SELECT public.report_excluded_phone8s() AS l),
wc AS MATERIALIZED (
  SELECT DISTINCT w.mex_tracking_id AS tr FROM public.web_orders w
  WHERE w.mex_tracking_id IS NOT NULL AND w.deleted_in_shop_at IS NULL
),
rp AS (       -- parcels MEX returned in the window, owned as a sale is (web claim → order → MEX-only)
  SELECT p.tracking_id,
         to_char(date_trunc(prm.gran, (p.returned_at AT TIME ZONE 'Europe/Skopje')::date::timestamp), prm.fmt) AS d,
         CASE WHEN EXISTS (SELECT 1 FROM wc WHERE wc.tr = p.tracking_id) THEN 'web'
              ELSE coalesce(
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE x.mex_tracking_id = p.tracking_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'
                  ORDER BY x.created_at, x.id LIMIT 1),
                (SELECT public.cohort_order_source(x.sale_source, x.sale_source_detail, x.mex_tracking_id, x.dept_override) FROM public.orders x
                  WHERE p.order_id IS NOT NULL AND x.id = p.order_id
                    AND x.sale_source_detail IS DISTINCT FROM 'disposition'),
                public.cohort_parcel_source(public.cohort_parcel_split(p.account, p.series, p.tracking_id, p.sender_reference))) END AS source
  FROM public.mex_parcels p CROSS JOIN prm CROSS JOIN xp
  WHERE p.returned_at BETWEEN prm.f AND prm.t
    AND NOT public.insights_excluded8(p.phone8, xp.l)
)
SELECT jsonb_build_object(
  'clock', 'cash',
  'vat_mode', 'per_line',
  'granularity', (SELECT gran FROM prm),
  'agg', coalesce((SELECT jsonb_agg(to_jsonb(agg) ORDER BY agg.g, agg.dim, agg.key) FROM agg
                    WHERE $4 OR agg.dim = 's'), '[]'::jsonb),
  'wm_names', CASE WHEN $4 THEN coalesce((SELECT jsonb_object_agg(wmn.wm_id, wmn.name)
                          FROM wmn WHERE wmn.wm_id IN (SELECT a.key FROM agg a WHERE a.dim = 'w')), '{}'::jsonb) END,
  'comm', coalesce((SELECT jsonb_agg(jsonb_build_object(
             'dim', CASE WHEN c.source IS NOT NULL THEN 's' WHEN c.d IS NOT NULL THEN 'd' ELSE 'w' END,
             'key', coalesce(c.source, c.d, c.wm), 'o', c.owner_raw, 'b', c.b, 'n', c.n))
           FROM comm c WHERE c.source IS NOT NULL OR ($4 AND (c.d IS NOT NULL OR c.wm IS NOT NULL))), '[]'::jsonb),
  'returned_parcels', coalesce((SELECT jsonb_agg(jsonb_build_object('s', r.source, 'd', r.d, 'n', r.n))
           FROM (SELECT rp.source, rp.d, count(*) AS n FROM rp GROUP BY 1, 2) r), '[]'::jsonb)
)
$th$;
  v_gran text;
  v_days integer;
  v_out  jsonb;
BEGIN
  IF p_from IS NULL OR p_to_end IS NULL OR p_to_end < p_from OR p_to_end - p_from > interval '800 days' THEN
    RAISE EXCEPTION 'insights_profit: bad window' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_clock, 'cohort') NOT IN ('cohort', 'cash') THEN
    RAISE EXCEPTION 'insights_profit: unknown clock %', p_clock USING ERRCODE = '22023';
  END IF;
  -- daily up to 62 Skopje days, monthly beyond (as insights_cohort's spark);
  -- a caller that splits a window passes the whole window's granularity
  v_days := (p_to_end AT TIME ZONE 'Europe/Skopje')::date - (p_from AT TIME ZONE 'Europe/Skopje')::date + 1;
  v_gran := CASE WHEN p_granularity IN ('day', 'month') THEN p_granularity
                 WHEN v_days <= 62 THEN 'day' ELSE 'month' END;

  IF coalesce(p_clock, 'cohort') = 'cohort' THEN
    EXECUTE v_head_cohort || v_common || v_tail_cohort INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  ELSE
    EXECUTE v_head_cash || v_common || v_tail_cash INTO v_out
      USING p_from, p_to_end, v_gran, coalesce(p_detail, true);
  END IF;
  RETURN v_out;
END;
$function$;

-- the read-only harness (scripts/verify-tab-profit.mjs, scripts/vat/compare-vat.mjs) may call the
-- helper; conditional for a fresh local database
DO $grant$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.product_vat_rate(uuid) TO supabase_read_only_user;
  END IF;
END
$grant$;

COMMIT;
