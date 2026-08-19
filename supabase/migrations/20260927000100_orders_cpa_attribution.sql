-- CPA attribution on the order itself: which affiliate sent it, and for which offer.
--
-- ── Why these live on `orders` and not in the ledger ─────────────────────────
-- 20260914000000 deliberately kept `orders` clean by putting every lead detail
-- in altercpa_leads, and that principle still holds for lead detail. These three
-- are the exception, for one measured reason: the ledger began with the live
-- poller on 2026-08-05, so it covers 2.305 of the 82.455 orders that carry
-- external_source='altercpa'. The other ~80k came from the one-off history
-- import and have no ledger row at all. A read-time join would leave the
-- feature blank on 97% of the table.
--
-- Storing them here also means GET /orders — which already selects `*` — feeds
-- the list, the expanded panel, the modal, the mobile card and the XLSX export
-- with no join anywhere, and both filters are a plain .eq().
--
-- The affiliate NAME is not stored: only the id. Renaming a partner is one
-- UPDATE in altercpa_webmasters, never 36.491 rows here.
--
-- cpa_offer_name IS denormalised on purpose — it is what their record said at
-- the time, it costs ~2 MB across the whole table, and it removes the need for a
-- second lookup table for something that never needs correcting.

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS cpa_webmaster_id text,
  ADD COLUMN IF NOT EXISTS cpa_offer_id     text,
  ADD COLUMN IF NOT EXISTS cpa_offer_name   text;

COMMENT ON COLUMN public.orders.cpa_webmaster_id IS
  'AlterCPA `wm` — the affiliate that sent this lead. Resolve to a name via altercpa_webmasters.';
COMMENT ON COLUMN public.orders.cpa_offer_id IS
  'AlterCPA `offer` — their numeric offer id.';
COMMENT ON COLUMN public.orders.cpa_offer_name IS
  'AlterCPA `offername` as it stood when the lead arrived. Historical record, not a live lookup.';

-- Partial: only ~82k of 88k rows carry attribution today and non-CPA orders
-- never will, so the NULLs are dead weight in a full index. These back the two
-- new /orders filters and the attribution-dimensions rollup.
CREATE INDEX IF NOT EXISTS idx_orders_cpa_webmaster
  ON public.orders (cpa_webmaster_id) WHERE cpa_webmaster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_orders_cpa_offer
  ON public.orders (cpa_offer_id) WHERE cpa_offer_id IS NOT NULL;

-- Backfill is NOT done here. It reads scripts/data/altercpa-mk-raw.jsonl (69 MB,
-- 81.657 verbatim API records) which a migration cannot see, and it must run
-- with triggers suppressed so trg_orders_updated_at does not stamp 82k rows —
-- GET /call-agains reports orders.updated_at as last_call_at.
--   node scripts/backfill-cpa-attribution.mjs            # dry run
--   node scripts/backfill-cpa-attribution.mjs --apply
