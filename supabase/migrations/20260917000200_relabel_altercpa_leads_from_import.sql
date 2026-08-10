-- Relabel the 42 open AlterCPA leads that are still tagged source_type='import'.
-- ============================================================================
-- This migration exists ONLY because of the two above it. Once Pendings means
-- `is_lead_source(source_type)`, an open lead whose source_type is 'import'
-- silently disappears from every queue, badge and chip. Verified on this
-- database 2026-08-10 — the 906 open rows break down as:
--
--     source_type  status      altercpa_leads sidecar   rows
--     -----------  ----------  ----------------------   ----
--     altercpa     pending     yes                       863
--     import       pending     no                         35
--     import       pending     YES                         6
--     import       call_again  no                          1
--
-- All 42 `import` rows carry external_source='altercpa'. They are genuine
-- AlterCPA leads that arrived through the 2026-08 history-import path, which
-- wrote source_type='import', rather than through the live poller in
-- supabase/functions/altercpa-sync/index.ts, which writes source_type='altercpa'.
-- The 6 with a sidecar are the ones the poller later linked by external_order_id
-- (863 + 6 = 869 = exactly the linked count in altercpa_leads).
--
-- **41 of the 42 are assigned to named agents right now.** Leaving them as
-- 'import' would strand real, actively-worked leads: still owned, still in the
-- Orders list, but absent from the owning agent's Pendings queue and from
-- assigned_pending_counts(). Operator decision 2026-08-10: relabel all 42.
--
-- SAFE FOR THE SEGMENT ENGINE — checked, not assumed. Every engine predicate in
-- this repo excludes 'monadon_legacy' (146 occurrences) and none of them tests
-- for 'import', so membership is unaffected by this change. Run
-- `node scripts/engine-fixture-mk.mjs` afterwards regardless.
--
-- SCOPE IS DELIBERATELY NARROW. The predicate is anchored on all three of
-- source_type + external_source + an OPEN status, so it cannot reach the 80.318
-- terminal-state legacy import rows. Idempotent: re-running matches 0 rows.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  affected int;
BEGIN
  UPDATE public.orders
     SET source_type = 'altercpa'
   WHERE source_type    = 'import'
     AND external_source = 'altercpa'
     AND status IN ('pending', 'take', 'call_again');

  GET DIAGNOSTICS affected = ROW_COUNT;
  RAISE NOTICE 'relabelled % open AlterCPA lead(s) from source_type=import to altercpa', affected;

  -- 42 when this was written (2026-08-10), 0 on any re-run, and legitimately a
  -- little lower if an agent dispositions one of them first — this is a live
  -- system. Deliberately NOT an equality check: the AlterCPA poller adds leads
  -- every 2 minutes, so any hardcoded total is stale before it ships.
  --
  -- The ceiling is the real guard. This population is historical and closed —
  -- new leads arrive as source_type='altercpa' from the live poller, never as
  -- 'import' — so it can only shrink. A jump means the predicate is catching
  -- something it was never meant to reach; stop rather than relabel 80k rows.
  IF affected > 100 THEN
    RAISE EXCEPTION 'relabel matched % rows, expected at most ~42 — the open-import population should only shrink. Re-inspect before applying.', affected;
  END IF;
END $$;

COMMIT;
