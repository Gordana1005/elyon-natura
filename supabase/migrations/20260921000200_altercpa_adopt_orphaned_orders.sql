-- AlterCPA bridge: adopt orders whose ledger row was never linked.
--
-- Found 2026-08-13 while asking why leads from 03-05 Aug were still `pending`.
-- 33 of them could never be resolved by anything: the order existed, a ledger
-- row for the same lead existed, and the two were not joined. The status cron's
-- candidate query requires `.not("order_id","is",null)`, so those orders were
-- invisible to it — AlterCPA had already cancelled, trashed or approved 20 of
-- them and nothing here would ever have found out. They would have sat in the
-- calling queue forever.
--
-- How it happened: upsertLead() only ever set order_id when it CREATED the
-- order. A lead that arrives already past phase 2 is deliberately not promoted
-- ("we do not book revenue our agents never earned") and gets
-- skip_reason='not_pending' with order_id NULL — but the order itself had
-- already been created by an earlier path, so the skip orphaned it. The root
-- cause is fixed in supabase/functions/altercpa-sync/index.ts, where a skipped
-- lead now ADOPTS an existing order (never creates one); this migration repairs
-- the rows that already exist.
--
-- Matched on the same (external_source, external_order_id) key upsertOrder
-- uses. Scoping to external_source is load-bearing: opencart orders carry
-- external_order_id too, and a bare id match could adopt a stranger's row.
-- Verified before writing: all 204 unlinked ledger rows match exactly ONE
-- order, so there is no ambiguity to resolve. The `= 1` guard keeps that true
-- if this is ever re-run against different data.
--
-- Safe by construction: this only writes altercpa_leads.order_id. No order
-- status moves here. The next status-sync run decides those, under its own
-- forward-only rank rule, which never rewrites a terminal status.

UPDATE public.altercpa_leads l
SET    order_id = m.order_id
FROM (
  -- array_agg(...)[1] rather than min(): Postgres has no min(uuid) aggregate.
  -- The HAVING below means there is exactly one element anyway.
  SELECT l2.id AS ledger_id, (array_agg(o.id))[1] AS order_id
  FROM   public.altercpa_leads l2
  JOIN   public.orders o
    ON   o.external_source   = 'altercpa'
   AND   o.external_order_id = l2.altercpa_id
  WHERE  l2.order_id IS NULL
  GROUP BY l2.id
  HAVING count(o.id) = 1
) m
WHERE l.id = m.ledger_id
  AND l.order_id IS NULL;

-- Reporting index: "find the ledger row for this order" and the reverse join
-- are both on the hot path of the 5-minute status cron.
CREATE INDEX IF NOT EXISTS idx_altercpa_leads_order_id
  ON public.altercpa_leads (order_id)
  WHERE order_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
