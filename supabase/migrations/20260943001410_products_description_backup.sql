-- The backup of the machine texts on products (owner feedback 01.10.2026, "Производи 2.0", point 3).
--
-- The catalogue scripts of 28.09.2026 wrote their own notes into products.description ("Креиран
-- автоматски (complete-catalogue, run …): производ со продажби што го немаше во каталогот — 5 имиња …
-- Набавната цена ја внесува сопственикот.") and into products.category ("Од продажби — collabBox/web
-- (28.09.2026)", "Без каталог — …", "AlterCPA — нови понуди (…)"). The owner: they look
-- unprofessional. The UI stops showing them (api productsCatalog.ts humanDescription / humanCategory)
-- and scripts/clear-product-machine-text.mjs clears them — backing up the old values HERE first, in
-- the same transaction, one row per product (the first backup of a product is never overwritten).
-- `--restore` puts them back where the product still carries the cleared value, which also keeps
-- the 28.09 scripts' rollbacks (they find their rows by `description LIKE '%run <id>%'`) possible.
--
-- No policies: service_role / the Management API only (RLS on, nothing granted).

CREATE TABLE IF NOT EXISTS public.products_description_backup_20261001 (
  product_id   uuid PRIMARY KEY,
  description  text,
  category     text,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  backed_up_by uuid,
  run_id       uuid
);

COMMENT ON TABLE public.products_description_backup_20261001 IS
  'The old products.description / category of the rows scripts/clear-product-machine-text.mjs cleared (machine text of the 28.09.2026 catalogue scripts). One row per product, first backup kept. --restore reads it. Migration 20260943001410.';

ALTER TABLE public.products_description_backup_20261001 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.products_description_backup_20261001 FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.products_description_backup_20261001 TO service_role;
