-- ============================================================================
-- STOCK v2 — 3/5: desired → apply (contract docs/STOCK-V2.md "SQL functions")
--
-- stock_v2_desired() — what the ledger SHOULD hold, one row per move:
--   parcel_out   −qty at created_at_mex into the parcel's out warehouse
--                (source mex, key mex:<tracking>:out) — every parcel created on/after
--                the opening (the route's valid_from), whatever its status;
--   return_in    +qty at returned_at, only while status_id = 7 (key mex:<tracking>:ret)
--                — a parcel created BEFORE the opening counts too (the count only saw
--                the shelf);
--   unpack_in    +qty at the override's time (override 'unpacked', key
--                ovr:<tracking>:unpack, source override);
--   Sigma        staged documents not vanished, not excluded (excluded_reason, the
--                stock_sigma_rules), of an included type (stock_sigma_doc_types.include),
--                at doc_date 12:00 Skopje, only on a tracked warehouse side whose
--                sigma_moves_from ≤ that time; a line's side picks the object (out =
--                object_from, in = object_to; one-object documents fall back to the
--                other), the kind follows the type (transfer → transfer_out / _in;
--                else ledger_kind, production_in ↔ production_use by side). A transfer
--                whose two objects map to the SAME warehouse moves nothing; an untracked
--                side is ignored; an item code that is not a stock_articles row is
--                skipped (shown by the health card);
--   manual       approved stock_manual_moves (receipt +to · transfer −from/+to · adjust
--                ±one side · writeoff −from · damaged −from/+damaged · unpack +to);
--   counts       approved stock_wh_counts per counted article at counted_at:
--                adjustment = counted − (previous counted + every non-count move in
--                [previous count, this count)); kind opening for an 'opening' count,
--                else count_adjust. packed_counted: the units in parcels already
--                deducted but not picked up at counted_at are taken off the counted figure.
-- stock_v2_pending() — desired vs applied per group (source_key, kind, article_code,
--   warehouse_id, event_at).
-- stock_v2_apply(p_trigger, p_dry) — the reconciling run: writes ONLY the differences
--   (a difference against an already applied group is a correction), refreshes
--   stock_parcel_state, logs stock_runs. One run at a time (transaction advisory lock,
--   shared with the count / move writers). Switched off it returns {"status":"disabled"}
--   at once — unless p_dry, which computes the same diff and writes nothing (totals by
--   kind + 50 samples).
-- stock_v2_reset(p_actor, p_reason) — switches off, then negates every non-zero group
--   (the ledger is append-only: a reset is a set of correction rows). Audited.
--
-- pg_cron 'stock-v2-apply' at :12 :27 :42 :57 — after mex-reconcile / web-sync /
-- collabBox. While stock_v2.enabled = false every tick returns at once.
--
-- desired() reads mex_parcels.picked_up_at (migration 20260945000900, workstream M) only
-- for a count saved with packed_counted; the body is dynamic SQL, so this migration
-- installs without it — apply 0900 before the engine runs (0500 checks it).
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regprocedure('public.stock_v2_parcels(timestamptz, timestamptz)') IS NULL THEN
    RAISE EXCEPTION 'stock v2 apply: apply 20260945000200 first';
  END IF;
END
$dep$;

-- ── 0. helpers ──────────────────────────────────────────────────────────────
-- a Sigma object as the keys write it: 'Ф00001-04' (company-object)
CREATE OR REPLACE FUNCTION public.stock_v2_sigma_object(p_company text, p_object text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE WHEN nullif(btrim(coalesce(p_object, '')), '') IS NULL THEN NULL
              WHEN btrim(p_object) ~ '-' OR nullif(btrim(coalesce(p_company, '')), '') IS NULL THEN btrim(p_object)
              ELSE btrim(p_company) || '-' || btrim(p_object) END
$$;

COMMENT ON FUNCTION public.stock_v2_sigma_object(text, text) IS
  'A Sigma object in the stock_warehouse_keys form: the object as written when it already carries its company (Ф00001-04), else company || ''-'' || object. Migration 20260945000300.';

-- is a staged Sigma document excluded by the rules? (an active exclude rule matches and no active include rule does)
CREATE OR REPLACE FUNCTION public.stock_v2_sigma_excluded(
  p_doc_key text, p_doc_type text, p_client text,
  p_company_from text, p_object_from text, p_company_to text, p_object_to text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH o AS (SELECT public.stock_v2_sigma_object(p_company_from, p_object_from) AS f,
                    public.stock_v2_sigma_object(p_company_to, p_object_to) AS t),
  m AS (
    SELECT r.action
    FROM public.stock_sigma_rules r CROSS JOIN o
    WHERE r.active
      AND jsonb_typeof(r.match) = 'object'
      AND (r.match ? 'client_code' OR r.match ? 'doc_type' OR r.match ? 'doc_key' OR r.match ? 'objects')
      AND (NOT r.match ? 'client_code' OR r.match ->> 'client_code' = p_client)
      AND (NOT r.match ? 'doc_type'    OR r.match ->> 'doc_type' = p_doc_type)
      AND (NOT r.match ? 'doc_key'     OR r.match ->> 'doc_key' = p_doc_key)
      AND (NOT r.match ? 'objects'
           OR (jsonb_typeof(r.match -> 'objects') = 'array'
               AND o.f IS NOT NULL AND o.t IS NOT NULL AND o.f <> o.t
               AND (r.match -> 'objects') ? o.f AND (r.match -> 'objects') ? o.t))
  )
  SELECT EXISTS (SELECT 1 FROM m WHERE m.action = 'exclude')
     AND NOT EXISTS (SELECT 1 FROM m WHERE m.action = 'include')
$$;

COMMENT ON FUNCTION public.stock_v2_sigma_excluded(text, text, text, text, text, text, text) IS
  'True when an active stock_sigma_rules exclude rule matches the document (client_code · doc_type · doc_key · objects = a document between two of the listed objects, either way) and no active include rule does. Migration 20260945000300.';

-- ── 1. what the ledger SHOULD hold ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_desired()
RETURNS TABLE (
  source_key   text,
  kind         text,
  article_code text,
  warehouse_id smallint,
  event_at     timestamptz,
  qty          numeric,
  source       text,
  tracking_id  text,
  count_id     uuid,
  sigma_doc    text,
  manual_id    uuid,
  lines_source text,
  provisional  boolean)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_parcels text;
  v_packed  boolean;
BEGIN
  -- stock_v2_apply() builds one parcel snapshot per run and hands it over here
  v_parcels := CASE WHEN to_regclass('pg_temp._stock_v2_parcels_snapshot') IS NOT NULL
                    THEN 'pg_temp._stock_v2_parcels_snapshot'
                    ELSE 'public.stock_v2_parcels(NULL, NULL)' END;
  SELECT EXISTS (SELECT 1 FROM public.stock_wh_counts c WHERE c.status = 'approved' AND c.packed_counted)
    INTO v_packed;

  RETURN QUERY EXECUTE format($q$
WITH
p AS MATERIALIZED (
  SELECT x.tracking_id, x.warehouse_id, x.return_warehouse_id, x.out_at, x.ret_at, x.unpack_at,
         x.articles, x.lines_source, x.provisional
  FROM %1$s x
  WHERE x.out_at IS NOT NULL OR x.ret_at IS NOT NULL
),
pm AS (
  SELECT 'mex:' || p.tracking_id || ':out' AS sk, 'parcel_out'::text AS k, a.key AS art, p.warehouse_id AS wh,
         p.out_at AS ev, -(a.value::numeric) AS q, 'mex'::text AS src, p.tracking_id AS tr,
         NULL::uuid AS cid, NULL::text AS sdoc, NULL::uuid AS mid, p.lines_source AS ls, p.provisional AS prov
  FROM p CROSS JOIN LATERAL jsonb_each_text(p.articles) a
  WHERE p.out_at IS NOT NULL
  UNION ALL
  SELECT 'mex:' || p.tracking_id || ':ret', 'return_in', a.key, p.return_warehouse_id,
         p.ret_at, a.value::numeric, 'mex', p.tracking_id, NULL, NULL, NULL, p.lines_source, p.provisional
  FROM p CROSS JOIN LATERAL jsonb_each_text(p.articles) a
  WHERE p.ret_at IS NOT NULL
  UNION ALL
  SELECT 'ovr:' || p.tracking_id || ':unpack', 'unpack_in', a.key, p.warehouse_id,
         p.unpack_at, a.value::numeric, 'override', p.tracking_id, NULL, NULL, NULL, p.lines_source, p.provisional
  FROM p CROSS JOIN LATERAL jsonb_each_text(p.articles) a
  WHERE p.unpack_at IS NOT NULL AND p.out_at IS NOT NULL
),
swh AS MATERIALIZED (
  SELECT k.key, w.id, w.tracked, w.sigma_moves_from
  FROM public.stock_warehouse_keys k JOIN public.stock_warehouses w ON w.id = k.warehouse_id
  WHERE k.system = 'sigma'
),
sd AS MATERIALIZED (
  SELECT d.doc_key, t.direction, t.ledger_kind,
         ((d.doc_date + time '12:00') AT TIME ZONE 'Europe/Skopje') AS ev,
         d.lines,
         public.stock_v2_sigma_object(d.company_from, d.object_from) AS ofrom,
         public.stock_v2_sigma_object(d.company_to, d.object_to) AS oto
  FROM public.stock_sigma_docs d
  JOIN public.stock_sigma_doc_types t ON t.doc_type = d.doc_type AND t.include
  WHERE d.vanished_at IS NULL
    AND d.excluded_reason IS NULL
    AND NOT public.stock_v2_sigma_excluded(d.doc_key, d.doc_type, d.client_code,
                                           d.company_from, d.object_from, d.company_to, d.object_to)
),
sdw AS (
  SELECT sd.*, wf.id AS wf, wf.tracked AS wf_t, wf.sigma_moves_from AS wf_from,
         wt.id AS wt, wt.tracked AS wt_t, wt.sigma_moves_from AS wt_from
  FROM sd
  LEFT JOIN swh wf ON wf.key = sd.ofrom
  LEFT JOIN swh wt ON wt.key = sd.oto
  WHERE NOT (sd.direction = 'transfer' AND wf.id IS NOT NULL AND wf.id = wt.id)
),
sl AS (
  SELECT sdw.*, l.item, l.side, l.q
  FROM sdw
  CROSS JOIN LATERAL (
    SELECT btrim(e ->> 'item_code') AS item, lower(coalesce(e ->> 'side', '')) AS side,
           sum(public.stock_v2_num(e ->> 'qty')) AS q
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(sdw.lines) = 'array' THEN sdw.lines ELSE '[]'::jsonb END) e
    GROUP BY 1, 2) l
),
sm AS (
  SELECT sl.doc_key, sl.ev, sl.item, x.k, x.wh, x.q, x.wfrom, x.wtracked
  FROM sl
  CROSS JOIN LATERAL (VALUES
    -- the side the goods leave
    (CASE WHEN sl.direction = 'transfer' THEN 'transfer_out'
          WHEN sl.ledger_kind IN ('shop_out', 'export_out', 'b2b_out', 'writeoff', 'production_use', 'transfer_out') THEN sl.ledger_kind
          WHEN sl.ledger_kind = 'production_in' THEN 'production_use'
          WHEN sl.ledger_kind IS NULL THEN CASE WHEN sl.direction = 'out' THEN 'shop_out' ELSE 'production_use' END
          ELSE sl.ledger_kind END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wf ELSE coalesce(sl.wf, sl.wt) END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wf_from ELSE CASE WHEN sl.wf IS NOT NULL THEN sl.wf_from ELSE sl.wt_from END END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wf_t ELSE CASE WHEN sl.wf IS NOT NULL THEN sl.wf_t ELSE sl.wt_t END END,
     -sl.q,
     sl.side = 'out' OR (sl.side NOT IN ('in', 'out') AND sl.direction IN ('out', 'transfer'))),
    -- the side they arrive
    (CASE WHEN sl.direction = 'transfer' THEN 'transfer_in'
          WHEN sl.ledger_kind IN ('receipt', 'production_in', 'b2b_return_in', 'shop_return_in', 'transfer_in') THEN sl.ledger_kind
          WHEN sl.ledger_kind = 'production_use' THEN 'production_in'
          WHEN sl.ledger_kind IS NULL THEN CASE WHEN sl.direction = 'in' THEN 'receipt' ELSE 'shop_return_in' END
          ELSE sl.ledger_kind END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wt ELSE coalesce(sl.wt, sl.wf) END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wt_from ELSE CASE WHEN sl.wt IS NOT NULL THEN sl.wt_from ELSE sl.wf_from END END,
     CASE WHEN sl.direction = 'transfer' THEN sl.wt_t ELSE CASE WHEN sl.wt IS NOT NULL THEN sl.wt_t ELSE sl.wf_t END END,
     sl.q,
     sl.side = 'in' OR (sl.side NOT IN ('in', 'out') AND sl.direction IN ('in', 'transfer')))
  ) x(k, wh, wfrom, wtracked, q, applies)
  WHERE x.applies
),
sg AS (
  SELECT 'sigma:' || sm.doc_key AS sk, sm.k, sm.item AS art, sm.wh::smallint AS wh, sm.ev, sm.q,
         'sigma'::text AS src, NULL::text AS tr, NULL::uuid AS cid, sm.doc_key AS sdoc, NULL::uuid AS mid,
         NULL::text AS ls, false AS prov
  FROM sm
  WHERE sm.wh IS NOT NULL AND sm.wtracked AND sm.wfrom IS NOT NULL AND sm.ev >= sm.wfrom
    AND sm.q IS NOT NULL AND sm.q <> 0
    AND EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = sm.item)
),
mm AS (
  SELECT m.id, m.kind, m.from_wh, m.to_wh, m.event_at, l.article_code, l.qty
  FROM public.stock_manual_moves m
  JOIN public.stock_manual_move_lines l ON l.move_id = m.id
  WHERE m.status = 'approved'
),
mn AS (
  SELECT 'manual:' || mm.id AS sk, x.k, mm.article_code AS art, x.wh, mm.event_at AS ev, x.q,
         'manual'::text AS src, NULL::text AS tr, NULL::uuid AS cid, NULL::text AS sdoc, mm.id AS mid,
         NULL::text AS ls, false AS prov
  FROM mm
  CROSS JOIN LATERAL (VALUES
    (CASE mm.kind WHEN 'transfer' THEN 'transfer_out' WHEN 'adjust' THEN 'adjust'
                  WHEN 'writeoff' THEN 'writeoff' WHEN 'damaged' THEN 'transfer_out' END, mm.from_wh, -mm.qty),
    (CASE mm.kind WHEN 'receipt' THEN 'receipt' WHEN 'transfer' THEN 'transfer_in' WHEN 'adjust' THEN 'adjust'
                  WHEN 'damaged' THEN 'damaged_in' WHEN 'unpack' THEN 'unpack_in' END, mm.to_wh, mm.qty)
  ) x(k, wh, q)
  JOIN public.stock_warehouses w ON w.id = x.wh AND w.tracked
  WHERE x.k IS NOT NULL
),
nc AS MATERIALIZED (
  SELECT * FROM pm UNION ALL SELECT * FROM sg UNION ALL SELECT * FROM mn
),
cl AS MATERIALIZED (       -- approved count lines of tracked warehouses
  SELECT c.id AS count_id, c.kind, c.warehouse_id, c.counted_at, c.created_at, c.packed_counted,
         l.article_code, l.counted_qty
  FROM public.stock_wh_counts c
  JOIN public.stock_wh_count_lines l ON l.count_id = c.id
  JOIN public.stock_warehouses w ON w.id = c.warehouse_id AND w.tracked
  WHERE c.status = 'approved'
),
tpk AS (                   -- packed_counted: units deducted but still in the warehouse at the count
  %2$s
),
ce AS (
  SELECT cl.*, cl.counted_qty - coalesce(tpk.q, 0) AS eff
  FROM cl LEFT JOIN tpk ON tpk.count_id = cl.count_id AND tpk.article_code = cl.article_code
),
cp AS MATERIALIZED (
  SELECT ce.*,
         lag(ce.counted_at) OVER w AS prev_at,
         lag(ce.eff) OVER w AS prev_eff
  FROM ce
  WINDOW w AS (PARTITION BY ce.warehouse_id, ce.article_code ORDER BY ce.counted_at, ce.created_at, ce.count_id)
),
ca AS (
  SELECT cp.count_id, cp.kind, cp.warehouse_id, cp.article_code, cp.counted_at,
         cp.eff - coalesce(cp.prev_eff, 0) - coalesce(sum(nc.q), 0) AS adj
  FROM cp
  LEFT JOIN nc ON nc.wh = cp.warehouse_id AND nc.art = cp.article_code
              AND nc.ev < cp.counted_at AND nc.ev >= coalesce(cp.prev_at, '-infinity'::timestamptz)
  GROUP BY cp.count_id, cp.kind, cp.warehouse_id, cp.article_code, cp.counted_at, cp.eff, cp.prev_eff
)
SELECT nc.sk, nc.k, nc.art, nc.wh::smallint, nc.ev, round(nc.q, 3), nc.src, nc.tr, nc.cid, nc.sdoc, nc.mid, nc.ls, nc.prov
FROM nc
WHERE nc.q <> 0
UNION ALL
SELECT 'count:' || ca.count_id, CASE WHEN ca.kind = 'opening' THEN 'opening' ELSE 'count_adjust' END,
       ca.article_code, ca.warehouse_id, ca.counted_at, round(ca.adj, 3), 'count', NULL::text, ca.count_id,
       NULL::text, NULL::uuid, NULL::text, false
FROM ca
WHERE round(ca.adj, 3) <> 0
$q$,
    v_parcels,
    CASE WHEN v_packed THEN $tp$
  SELECT c.count_id, a.key AS article_code, sum(a.value::numeric) AS q
  FROM (SELECT DISTINCT cl.count_id, cl.warehouse_id, cl.counted_at FROM cl WHERE cl.packed_counted) c
  JOIN p ON p.warehouse_id = c.warehouse_id AND p.out_at < c.counted_at
  JOIN public.mex_parcels mp ON mp.tracking_id = p.tracking_id
  CROSS JOIN LATERAL jsonb_each_text(p.articles) a
  WHERE (mp.picked_up_at IS NULL AND mp.status_id = 8) OR mp.picked_up_at >= c.counted_at
  GROUP BY 1, 2$tp$
    ELSE 'SELECT NULL::uuid AS count_id, NULL::text AS article_code, NULL::numeric AS q WHERE false' END);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_desired() IS
  'Stock v2: every move the ledger SHOULD hold — parcel_out / return_in / unpack_in from stock_v2_parcels(), the staged Sigma documents, approved manual moves and approved counts (adjustment = counted − (previous counted + non-count moves since)). Keyed by (source_key, kind, article_code, warehouse_id, event_at). Read by stock_v2_pending / stock_v2_apply and by every report in preview. Migration 20260945000300.';

-- ── 2. desired against applied ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_pending()
RETURNS TABLE (
  source_key   text,
  kind         text,
  article_code text,
  warehouse_id smallint,
  event_at     timestamptz,
  desired      numeric,
  applied      numeric,
  delta        numeric,
  correction   boolean,
  source       text,
  tracking_id  text,
  count_id     uuid,
  sigma_doc    text,
  manual_id    uuid,
  lines_source text,
  provisional  boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $pending$
WITH
d AS (
  SELECT x.source_key, x.kind, x.article_code, x.warehouse_id, x.event_at, sum(x.qty) AS q,
         max(x.source) AS src, max(x.tracking_id) AS tr, max(x.count_id::text)::uuid AS cid,
         max(x.sigma_doc) AS sdoc, max(x.manual_id::text)::uuid AS mid, max(x.lines_source) AS ls,
         bool_or(x.provisional) AS prov
  FROM public.stock_v2_desired() x
  GROUP BY 1, 2, 3, 4, 5
),
a AS (
  SELECT m.source_key, m.kind, m.article_code, m.warehouse_id, m.event_at, sum(m.qty) AS q,
         max(m.source) AS src, max(m.tracking_id) AS tr, max(m.count_id::text)::uuid AS cid,
         max(m.sigma_doc) AS sdoc, max(m.manual_id::text)::uuid AS mid, max(m.lines_source) AS ls
  FROM public.stock_moves m
  GROUP BY 1, 2, 3, 4, 5
)
SELECT coalesce(d.source_key, a.source_key), coalesce(d.kind, a.kind), coalesce(d.article_code, a.article_code),
       coalesce(d.warehouse_id, a.warehouse_id), coalesce(d.event_at, a.event_at),
       coalesce(d.q, 0), coalesce(a.q, 0), coalesce(d.q, 0) - coalesce(a.q, 0),
       a.source_key IS NOT NULL,
       coalesce(d.src, a.src), coalesce(d.tr, a.tr), coalesce(d.cid, a.cid), coalesce(d.sdoc, a.sdoc),
       coalesce(d.mid, a.mid), coalesce(d.ls, a.ls), coalesce(d.prov, false)
FROM d
FULL JOIN a ON a.source_key = d.source_key AND a.kind = d.kind AND a.article_code = d.article_code
           AND a.warehouse_id = d.warehouse_id AND a.event_at = d.event_at
WHERE coalesce(d.q, 0) <> coalesce(a.q, 0)
$pending$;

COMMENT ON FUNCTION public.stock_v2_pending() IS
  'Stock v2: per group (source_key, kind, article_code, warehouse_id, event_at) the desired against the applied quantity; delta = what a run would write (correction = the group was applied before). Empty right after a run. Migration 20260945000300.';

-- ── 3. the run ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_apply(p_trigger text DEFAULT 'cron', p_dry boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_dry     boolean := coalesce(p_dry, false);
  v_trigger text := left(coalesce(nullif(btrim(p_trigger), ''), 'cron'), 40);
  v_ro      boolean := current_setting('transaction_read_only') = 'on';
  v_run     uuid;
  v_t0      timestamptz := clock_timestamp();
  v_stats   jsonb;
  v_moves   integer := 0;
  v_states  integer := 0;
  v_err     text;
BEGIN
  IF NOT v_dry AND NOT public.stock_v2_enabled() THEN
    RETURN jsonb_build_object('status', 'disabled');
  END IF;
  IF NOT v_dry AND v_ro THEN
    RETURN jsonb_build_object('status', 'failed', 'error', 'read_only_transaction');
  END IF;
  IF NOT v_dry AND NOT pg_try_advisory_xact_lock(hashtext('public.stock_v2_apply')) THEN
    RETURN jsonb_build_object('status', 'busy');
  END IF;

  IF NOT v_ro THEN
    INSERT INTO public.stock_runs (trigger, dry) VALUES (v_trigger, v_dry) RETURNING id INTO v_run;
  END IF;

  BEGIN
    IF v_dry THEN
      -- one statement, no temp tables (works in a read-only transaction)
      WITH x AS MATERIALIZED (SELECT * FROM public.stock_v2_pending())
      SELECT jsonb_build_object(
               'groups', count(*),
               'corrections', count(*) FILTER (WHERE x.correction),
               'parcels', count(DISTINCT x.tracking_id),
               'units_out', coalesce(-sum(x.delta) FILTER (WHERE x.kind = 'parcel_out'), 0),
               'units_back', coalesce(sum(x.delta) FILTER (WHERE x.kind IN ('return_in', 'unpack_in')), 0),
               'by_kind', coalesce((SELECT jsonb_object_agg(k.kind, jsonb_build_object('rows', k.n, 'qty', k.q))
                                      FROM (SELECT x2.kind, count(*) AS n, sum(x2.delta) AS q FROM x x2 GROUP BY 1) k), '{}'::jsonb),
               'samples', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                       'source_key', s.source_key, 'kind', s.kind, 'article_code', s.article_code,
                                       'warehouse', (SELECT w.code FROM public.stock_warehouses w WHERE w.id = s.warehouse_id),
                                       'event_at', s.event_at, 'desired', s.desired, 'applied', s.applied,
                                       'delta', s.delta, 'correction', s.correction)
                                     ORDER BY abs(s.delta) DESC, s.event_at DESC, s.source_key)
                                      FROM (SELECT * FROM x x3 ORDER BY abs(x3.delta) DESC, x3.event_at DESC, x3.source_key LIMIT 50) s),
                                   '[]'::jsonb))
        INTO v_stats
        FROM x;
    ELSE
      -- ONE parcel snapshot per run, read by stock_v2_desired() and the parcel states
      DROP TABLE IF EXISTS pg_temp._stock_v2_parcels_snapshot;
      CREATE TEMP TABLE _stock_v2_parcels_snapshot ON COMMIT DROP AS
        SELECT * FROM public.stock_v2_parcels(NULL, NULL);
      DROP TABLE IF EXISTS pg_temp._stock_v2_diff;
      CREATE TEMP TABLE _stock_v2_diff ON COMMIT DROP AS
        SELECT * FROM public.stock_v2_pending();
      ANALYZE pg_temp._stock_v2_diff;

      PERFORM set_config('elyon.stock_write', 'on', true);

      INSERT INTO public.stock_moves
        (article_code, warehouse_id, qty, kind, event_at, source, source_key, correction, provisional,
         tracking_id, sigma_doc, count_id, manual_id, lines_source, run_id)
      SELECT x.article_code, x.warehouse_id, x.delta, x.kind, x.event_at, x.source, x.source_key, x.correction,
             x.provisional, x.tracking_id, x.sigma_doc, x.count_id, x.manual_id, x.lines_source, v_run
      FROM pg_temp._stock_v2_diff x
      WHERE x.delta <> 0
      ORDER BY x.event_at, x.source_key, x.kind, x.article_code, x.warehouse_id;
      GET DIAGNOSTICS v_moves = ROW_COUNT;

      -- the parcel verdicts (only the ones that changed)
      WITH s AS (
        SELECT p.tracking_id, p.warehouse_id, p.return_warehouse_id, p.lines_source, p.state,
               p.units_out, p.units_back, p.unmapped, p.flags,
               md5(concat_ws('|', p.warehouse_id, p.return_warehouse_id, p.lines_source, p.state,
                             p.units_out, p.units_back, p.unmapped::text, array_to_string(p.flags, ','))) AS fp
        FROM pg_temp._stock_v2_parcels_snapshot p
      )
      INSERT INTO public.stock_parcel_state AS t
        (tracking_id, warehouse_id, return_warehouse_id, lines_source, state, units_out, units_back,
         unmapped, flags, fingerprint, updated_at)
      SELECT s.tracking_id, s.warehouse_id, s.return_warehouse_id, s.lines_source, s.state, s.units_out,
             s.units_back, s.unmapped, s.flags, s.fp, now()
      FROM s
      ORDER BY s.tracking_id
      ON CONFLICT (tracking_id) DO UPDATE SET
        warehouse_id = EXCLUDED.warehouse_id, return_warehouse_id = EXCLUDED.return_warehouse_id,
        lines_source = EXCLUDED.lines_source, state = EXCLUDED.state, units_out = EXCLUDED.units_out,
        units_back = EXCLUDED.units_back, unmapped = EXCLUDED.unmapped, flags = EXCLUDED.flags,
        fingerprint = EXCLUDED.fingerprint, updated_at = now()
      WHERE t.fingerprint IS DISTINCT FROM EXCLUDED.fingerprint;
      GET DIAGNOSTICS v_states = ROW_COUNT;

      PERFORM set_config('elyon.stock_write', 'off', true);

      SELECT jsonb_build_object(
               'groups', count(*),
               'moves', v_moves,
               'corrections', count(*) FILTER (WHERE x.correction),
               'parcels', count(DISTINCT x.tracking_id),
               'parcel_states_changed', v_states,
               'units_out', coalesce(-sum(x.delta) FILTER (WHERE x.kind = 'parcel_out'), 0),
               'units_back', coalesce(sum(x.delta) FILTER (WHERE x.kind IN ('return_in', 'unpack_in')), 0),
               'by_kind', coalesce((SELECT jsonb_object_agg(k.kind, jsonb_build_object('rows', k.n, 'qty', k.q))
                                      FROM (SELECT x2.kind, count(*) AS n, sum(x2.delta) AS q
                                              FROM pg_temp._stock_v2_diff x2 GROUP BY 1) k), '{}'::jsonb),
               'samples', coalesce((SELECT jsonb_agg(jsonb_build_object(
                                       'source_key', s.source_key, 'kind', s.kind, 'article_code', s.article_code,
                                       'warehouse', (SELECT w.code FROM public.stock_warehouses w WHERE w.id = s.warehouse_id),
                                       'event_at', s.event_at, 'desired', s.desired, 'applied', s.applied,
                                       'delta', s.delta, 'correction', s.correction)
                                     ORDER BY abs(s.delta) DESC, s.event_at DESC, s.source_key)
                                      FROM (SELECT * FROM pg_temp._stock_v2_diff x3
                                             ORDER BY abs(x3.delta) DESC, x3.event_at DESC, x3.source_key LIMIT 50) s),
                                   '[]'::jsonb))
        INTO v_stats
        FROM pg_temp._stock_v2_diff x;

      DROP TABLE IF EXISTS pg_temp._stock_v2_parcels_snapshot;
      DROP TABLE IF EXISTS pg_temp._stock_v2_diff;
    END IF;

    v_stats := v_stats || jsonb_build_object(
      'duration_ms', (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer);

    IF v_run IS NOT NULL THEN
      UPDATE public.stock_runs
         SET status = 'ok', stats = v_stats - 'samples', finished_at = clock_timestamp()
       WHERE id = v_run;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
    IF v_run IS NOT NULL THEN
      UPDATE public.stock_runs
         SET status = 'failed', error = left(v_err, 1000), finished_at = clock_timestamp(),
             stats = jsonb_build_object('duration_ms', (extract(epoch FROM clock_timestamp() - v_t0) * 1000)::integer)
       WHERE id = v_run;
    END IF;
    RETURN jsonb_build_object('status', 'failed', 'run_id', v_run, 'dry', v_dry, 'trigger', v_trigger, 'error', v_err);
  END;

  -- quiet runs are not worth keeping for long
  IF NOT v_ro THEN
    DELETE FROM public.stock_runs r
     WHERE r.started_at < now() - interval '60 days' AND r.status = 'ok'
       AND (r.dry OR coalesce((r.stats ->> 'groups')::integer, 0) = 0)
       AND NOT EXISTS (SELECT 1 FROM public.stock_moves m WHERE m.run_id = r.id);
  END IF;

  RETURN jsonb_build_object('status', 'ok', 'run_id', v_run, 'dry', v_dry, 'trigger', v_trigger) || v_stats;
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_apply(text, boolean) IS
  'Stock v2 run (pg_cron stock-v2-apply at :12/:27/:42/:57; the api at the switch / on demand): writes into stock_moves ONLY the differences between stock_v2_desired() and the applied groups (correction = against an already applied group), refreshes stock_parcel_state, logs stock_runs. Off → {"status":"disabled"} unless p_dry; p_dry → the same diff, totals by kind + 50 samples, nothing written. One run at a time (advisory lock) → {"status":"busy"}. Migration 20260945000300.';

-- ── 4. the reset ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_reset(p_actor uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
AS $fn$
DECLARE
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_email  text;
  v_before jsonb;
  v_run    uuid;
  v_rows   integer := 0;
  v_units  numeric := 0;
  v_states integer := 0;
BEGIN
  IF p_actor IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'actor_required');
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT u.email INTO v_email FROM auth.users u WHERE u.id = p_actor;

  -- 1. switch off
  SELECT a.value INTO v_before FROM public.app_settings a WHERE a.key = 'stock_v2' FOR UPDATE;
  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES ('stock_v2', public.stock_v2_settings()
                      || jsonb_build_object('enabled', false, 'changed_at', now(), 'changed_by', p_actor,
                                            'reset_at', now()), p_actor)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  -- 2. negate every group that is not zero
  INSERT INTO public.stock_runs (trigger, dry, actor) VALUES ('reset', false, p_actor) RETURNING id INTO v_run;
  PERFORM set_config('elyon.stock_write', 'on', true);
  WITH g AS (
    SELECT m.source_key, m.kind, m.article_code, m.warehouse_id, m.event_at, sum(m.qty) AS q,
           max(m.source) AS src, max(m.tracking_id) AS tr, max(m.sigma_doc) AS sdoc,
           max(m.count_id::text)::uuid AS cid, max(m.manual_id::text)::uuid AS mid, max(m.lines_source) AS ls
    FROM public.stock_moves m
    GROUP BY 1, 2, 3, 4, 5
    HAVING sum(m.qty) <> 0
  ), ins AS (
    INSERT INTO public.stock_moves
      (article_code, warehouse_id, qty, kind, event_at, source, source_key, correction, provisional,
       tracking_id, sigma_doc, count_id, manual_id, lines_source, run_id)
    SELECT g.article_code, g.warehouse_id, -g.q, g.kind, g.event_at, g.src, g.source_key, true, false,
           g.tr, g.sdoc, g.cid, g.mid, g.ls, v_run
    FROM g
    ORDER BY g.event_at, g.source_key, g.kind, g.article_code, g.warehouse_id
    RETURNING qty
  )
  SELECT count(*), coalesce(sum(abs(ins.qty)), 0) INTO v_rows, v_units FROM ins;
  DELETE FROM public.stock_parcel_state;
  GET DIAGNOSTICS v_states = ROW_COUNT;
  PERFORM set_config('elyon.stock_write', 'off', true);

  UPDATE public.stock_runs
     SET status = 'ok', finished_at = clock_timestamp(),
         stats = jsonb_build_object('groups_negated', v_rows, 'units_negated', v_units, 'parcel_states_cleared', v_states)
   WHERE id = v_run;

  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, v_email, 'stock_v2.reset', 'stock_v2', v_run::text, 'stock ledger',
          jsonb_build_object('reason', v_reason, 'before', v_before, 'groups_negated', v_rows,
                             'units_negated', v_units, 'run_id', v_run));

  RETURN jsonb_build_object('ok', true, 'run_id', v_run, 'groups_negated', v_rows, 'units_negated', v_units,
                            'parcel_states_cleared', v_states, 'enabled', false);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_reset(uuid, text) IS
  'Stock v2 reset (owners, through the api): switches stock_v2 off, then writes one correction row negating every non-zero ledger group (append-only: nothing is deleted), clears stock_parcel_state, audits stock_v2.reset. Migration 20260945000300.';

-- ── 5. grants ───────────────────────────────────────────────────────────────
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY['public.stock_v2_sigma_object(text, text)',
                           'public.stock_v2_sigma_excluded(text, text, text, text, text, text, text)',
                           'public.stock_v2_desired()', 'public.stock_v2_pending()',
                           'public.stock_v2_apply(text, boolean)', 'public.stock_v2_reset(uuid, text)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  -- read-only checkers (scripts/verify-stock-v2.mjs) — STABLE readers only
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.stock_v2_sigma_object(text, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_v2_sigma_excluded(text, text, text, text, text, text, text) TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_v2_desired() TO supabase_read_only_user;
    GRANT EXECUTE ON FUNCTION public.stock_v2_pending() TO supabase_read_only_user;
    -- scripts/stock/stock-run.mjs's DRY run: in a read-only transaction stock_v2_apply() writes nothing
    -- (p_dry computes in one statement; a non-dry call answers read_only_transaction before any write)
    GRANT EXECUTE ON FUNCTION public.stock_v2_apply(text, boolean) TO supabase_read_only_user;
  END IF;
END
$grants$;

-- ── 6. schedule — every 15 minutes; switched off a tick returns at once ─────
DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'stock-v2-apply') THEN
    PERFORM cron.unschedule('stock-v2-apply');
  END IF;
END
$cron$;

SELECT cron.schedule(
  'stock-v2-apply',
  '12,27,42,57 * * * *',
  $job$SELECT public.stock_v2_apply('cron');$job$
);

NOTIFY pgrst, 'reload schema';

COMMIT;
