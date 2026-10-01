-- VAT per product — five corrections after the 01.10.2026 backfill (20260944000900), owner Mile:
-- "поправи ги сите … поправи ги во нашиот систем". Every row below kept a rate that is wrong for
-- what the product IS, so it moves to 18 %:
--
--   AURA BASE База за сенка Prime Me, AURA Апликатори за сенка за очи
--       make-up, but the S2 crosswalk linked them to ZINC tablets (Sigma 001670 / 001529, 5 %) —
--       a wrong link; make-up / cosmetics = 18 % (every other AURA row is already 18 %)
--   МАИЦИ, МАИЦИ XL
--       T-shirts, linked to МАКА ЕКСТРАКТ 30 cps (Sigma 000308, 5 %) — a wrong link; clothing is not
--       a food supplement = 18 % (the same rule that already gives хеланки / торби 18 %)
--   ТАБЛЕТ-СТ95
--       the link is right (Sigma 051668), but SIGMA ITSELF carries this loyalty-prize tablet at 5 %
--       (VatId 2) — one of Sigma's own VAT errors, listed in Сигма_ДДВ_неправилности_2026-10-01.xlsx
--       sheet "A Артикли-стапка"; a device = 18 %. The Sigma item is named in the evidence text.
--
-- docs/vat/crm_products_vat.json is the corrected table (these five at 18 %); vatRates.test.ts checks
-- that 900's backfill + these fixes = that table, row by row.
--
-- None of the five has a sale since 2025 and all are inactive, so no report number changes; this is
-- for a correct catalogue. Same write path as the backfill (the guard's transaction-local gate,
-- updated_at kept, no audit_log row — audit_log.actor_id is NOT NULL and a migration has no human
-- actor; the record is this file). A row an owner has changed since (vat_source = 'owner') is left.
-- Mixed supplement + cosmetic bundles keep their main product's rate (docs/VAT.md §Bundles).
-- Rollback: re-run the 20260944000900 values for these five ids (docs/vat/crm_products_vat.json).

BEGIN;

SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE vat_fix (
  id uuid PRIMARY KEY,
  rate numeric(4,3) NOT NULL,
  source text NOT NULL,
  sigma_code text,
  sigma_name text,
  evidence text NOT NULL
) ON COMMIT DROP;

INSERT INTO pg_temp.vat_fix (id, rate, source, sigma_code, sigma_name, evidence) VALUES
  ('44b4eaad-24dd-43d2-867c-4f1ff9c44932', 0.18, 'rule:cosmetic-18', NULL, NULL,
   'шминка = 18 %; врската во S2 crosswalk кон ZINC 120/1 tab (Sigma 001670, 5 %) беше погрешна — поправено 01.10.2026'),
  ('622e1b33-c225-46b9-bd34-76fa8ca1e2cd', 0.18, 'rule:cosmetic-18', NULL, NULL,
   'шминка / прибор за шминка = 18 %; врската во S2 crosswalk кон ZINC 365 tbl (Sigma 001529, 5 %) беше погрешна — поправено 01.10.2026'),
  ('b070ca90-697f-459f-ad93-defbbdd9b0d5', 0.18, 'rule:device-18', NULL, NULL,
   'облека = 18 %; врската во S2 crosswalk кон МАКА ЕКСТРАКТ 30 cps (Sigma 000308, 5 %) беше погрешна — поправено 01.10.2026'),
  ('a84853ee-0171-4e60-98ee-61ea36adecde', 0.18, 'rule:device-18', NULL, NULL,
   'облека = 18 %; врската во S2 crosswalk кон МАКА ЕКСТРАКТ 30 cps (Sigma 000308, 5 %) беше погрешна — поправено 01.10.2026'),
  ('ae4b09f0-ee8a-4f89-b93c-427c5d68c668', 0.18, 'rule:device-18', NULL, NULL,
   'уред = 18 %; Сигма го води артиклот 051668 ТАБЛЕТ-СТ95 на 5 % (ЛОЈАЛИТИ, VatId 2) — грешка во Сигма (Сигма_ДДВ_неправилности_2026-10-01.xlsx, лист A); поправено во нашиот систем 01.10.2026');

DO $fix$
DECLARE
  v_done int;
  v_owner int;
BEGIN
  IF to_regclass('public.products') IS NULL
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns
                     WHERE table_schema = 'public' AND table_name = 'products' AND column_name = 'vat_rate') THEN
    RAISE EXCEPTION 'product VAT fixes: products.vat_rate missing — apply 20260944000900 first';
  END IF;

  SELECT count(*) INTO v_owner
    FROM public.products p JOIN vat_fix f ON f.id = p.id
   WHERE p.vat_source = 'owner';
  IF v_owner > 0 THEN
    RAISE NOTICE 'product VAT fixes: % row(s) changed by an owner since the backfill — left as they are', v_owner;
  END IF;

  PERFORM set_config('elyon.keep_updated_at', 'on', true);
  PERFORM set_config('elyon.vat_rate_write', 'on', true);
  UPDATE public.products p
     SET vat_rate = f.rate, vat_source = f.source, vat_sigma_code = f.sigma_code, vat_sigma_name = f.sigma_name,
         vat_evidence = f.evidence, vat_set_by = NULL, vat_set_at = now()
    FROM vat_fix f
   WHERE f.id = p.id AND p.vat_source IS DISTINCT FROM 'owner';
  GET DIAGNOSTICS v_done = ROW_COUNT;
  PERFORM set_config('elyon.vat_rate_write', 'off', true);
  PERFORM set_config('elyon.keep_updated_at', 'off', true);

  RAISE NOTICE 'product VAT fixes: % products set to 18 %% (now % at 5 %%, % at 18 %%)', v_done,
    (SELECT count(*) FROM public.products WHERE vat_rate = 0.05), (SELECT count(*) FROM public.products WHERE vat_rate = 0.18);
END
$fix$;

COMMIT;
