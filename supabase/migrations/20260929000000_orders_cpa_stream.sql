-- Third CPA attribution dimension: the affiliate's traffic-source (stream) code.
-- cpa_webmaster_id says WHICH PARTNER, cpa_offer_id says FOR WHAT — this says
-- WHICH PUBLISHER under the partner. KMA.biz (#2676) is a reseller network, so
-- this code is the only way to tell its media buyers apart (their panel calls
-- the grouping "Lead distribution by affiliate traffic sources").
--
-- ── RAW CODE ON PURPOSE — operator decision 2026-08-19 ───────────────────────
-- "the publisher code is okay.. no needed names": no altercpa_streams registry,
-- no sighting function, no naming UI. This deliberately deviates from the
-- altercpa_webmasters pattern (20260927000000). The codes have no names ANYWHERE
-- upstream — the tracking fields are undocumented in AlterCPA's API and even
-- their own panel renders the bare hashes — so there is nothing to resolve.
--
-- Source of truth: AlterCPA `tracking.exts` (verified live: the panel's hashes
-- appear verbatim there). NOT `tracking.extu` — that is a per-lead click id
-- (81.551 distinct across 81.637 records) — and NOT `tracking.source`, which is
-- a UTM-ish creative axis populated only on KMA leads. Coverage measured
-- 2026-08-19: 100% of live leads, 85,2% of the 81.657-record history dump.
-- Empty exts stays NULL, never a placeholder — the UI simply omits the line.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cpa_stream_id text;

COMMENT ON COLUMN public.orders.cpa_stream_id IS
  'AlterCPA tracking.exts — the traffic-source/stream code: the publisher/media buyer under cpa_webmaster_id. Raw code by design, no name registry (operator decision 2026-08-19). Not extu (per-lead click id), not tracking.source (UTM axis).';

-- Composite where 20260927000100 used single columns, on purpose: the second
-- column keeps the streams rollup in altercpa_attribution_dimensions() and
-- altercpa_stream_distribution()'s dimension grain an index-only scan
-- (GROUP BY cpa_stream_id, cpa_webmaster_id), while the leading column alone
-- serves the /orders .eq filter. wm is part of the grain because exts formats
-- are heterogeneous — 16-char hashes for KMA, bare numerics like 1363 for
-- Fomikch/ezaff — so a numeric code could someday recur under a second partner
-- (0 collisions measured today across ~200 distinct codes).
CREATE INDEX IF NOT EXISTS idx_orders_cpa_stream
  ON public.orders (cpa_stream_id, cpa_webmaster_id) WHERE cpa_stream_id IS NOT NULL;

-- Backfill is NOT done here — same reasons as 20260927000100: it reads
-- scripts/data/altercpa-mk-raw.jsonl (69 MB, 81.657 verbatim API records) which
-- a migration cannot see, and it must run with triggers suppressed so
-- trg_orders_updated_at does not stamp ~69k rows — GET /call-agains reports
-- orders.updated_at as last_call_at.
--   node scripts/backfill-cpa-stream.mjs            # dry run
--   node scripts/backfill-cpa-stream.mjs --apply
