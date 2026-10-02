-- ============================================================================
-- STOCK v2 — 4/5: the audited writers (contract docs/STOCK-V2.md "Writers")
--
-- Every write into the stock v2 configuration, mapping, count, manual-move and
-- override tables goes through one of these SECURITY DEFINER functions (service
-- role only — the api calls them after its own permission check). Each one:
--   * takes p_actor (the auth user id; required — audit_log.actor_id is NOT NULL),
--   * validates its input and answers {"ok": false, "error": "<code>", …} instead of
--     raising (the api maps that to a 400),
--   * opens the transaction-local gate elyon.stock_write = 'on' only around its own
--     writes (the guard triggers of 20260945000100 refuse everything else),
--   * writes ONE audit_log row (action stock_v2.* / products.*),
--   * where it changes what the ledger should hold (counts, moves, overrides,
--     configuration), takes the same transaction advisory lock as stock_v2_apply(),
--     so a run and a write never interleave.
-- Owner checks are the api's: the writers take p_actor, and stock_v2_count_save
-- takes p_is_owner (a non-owner's count is saved 'pending' and may not be dated at
-- or before the warehouse's last approved count).
--
-- Additions to the contract (documented in docs/STOCK-V2.md): stock_v2_config()
-- (the StockConfig reader for GET stock/v2/config), stock_v2_count_approve() (POST
-- stock/v2/count/:id/approve), stock_v2_manual_move_void(), and the internal helpers
-- stock_v2_audit(), stock_v2_parse_lines(), stock_v2_cost_at().
--
-- Nothing here runs at install time; all tables stay empty.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '10s';

DO $dep$
BEGIN
  IF to_regprocedure('public.stock_v2_apply(text, boolean)') IS NULL THEN
    RAISE EXCEPTION 'stock v2 writers: apply 20260945000300 first';
  END IF;
END
$dep$;

-- ── 0. helpers ──────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_audit(
  p_actor uuid, p_action text, p_target_type text, p_target_id text, p_target_name text, p_payload jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
  VALUES (p_actor, (SELECT u.email FROM auth.users u WHERE u.id = p_actor), p_action, p_target_type,
          p_target_id, left(p_target_name, 200), coalesce(p_payload, '{}'::jsonb));
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_audit(uuid, text, text, text, text, jsonb) IS
  'One audit_log row for a stock v2 writer (actor e-mail looked up). Internal. Migration 20260945000400.';

-- [{code, qty}] → {"ok", "error", "bad": [...], "lines": [{code, name, unit, qty}]}; КОМ quantities must be whole
CREATE OR REPLACE FUNCTION public.stock_v2_parse_lines(p_lines jsonb, p_min numeric DEFAULT 0, p_max numeric DEFAULT 10000000,
                                                       p_max_lines integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_err text;
  v_bad jsonb;
  v_out jsonb;
BEGIN
  IF p_lines IS NULL OR jsonb_typeof(p_lines) <> 'array' OR jsonb_array_length(p_lines) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'lines_required');
  END IF;
  IF jsonb_array_length(p_lines) > p_max_lines THEN
    RETURN jsonb_build_object('ok', false, 'error', 'too_many_lines', 'max', p_max_lines);
  END IF;

  WITH x AS (
    SELECT e.ord, jsonb_typeof(e.v) AS t,
           upper(btrim(coalesce(e.v ->> 'code', ''))) AS code,
           CASE WHEN jsonb_typeof(e.v -> 'qty') = 'number' THEN (e.v ->> 'qty')::numeric
                ELSE public.stock_v2_num(e.v ->> 'qty') END AS q
    FROM jsonb_array_elements(p_lines) WITH ORDINALITY AS e(v, ord)
  ),
  y AS (
    SELECT x.*, a.code AS acode, a.name, a.unit,
           CASE WHEN x.t <> 'object' THEN 'bad_line'
                WHEN x.code = '' THEN 'code_required'
                WHEN a.code IS NULL THEN 'unknown_article'
                WHEN x.q IS NULL THEN 'bad_quantity'
                WHEN x.q < p_min OR x.q > p_max THEN 'quantity_out_of_range'
                WHEN x.q <> round(x.q, 3) THEN 'too_many_decimals'
                WHEN upper(a.unit) IN ('КОМ', 'KOM', 'PCS', 'ПАК') AND x.q <> trunc(x.q) THEN 'whole_units_only'
                WHEN count(*) OVER (PARTITION BY x.code) > 1 THEN 'duplicate_article'
           END AS why
    FROM x LEFT JOIN public.stock_articles a ON a.code = x.code
  )
  SELECT (SELECT y2.why FROM y y2 WHERE y2.why IS NOT NULL ORDER BY y2.ord LIMIT 1),
         coalesce((SELECT jsonb_agg(jsonb_build_object('line', y3.ord, 'code', y3.code, 'qty', y3.q, 'why', y3.why) ORDER BY y3.ord)
                     FROM (SELECT * FROM y y4 WHERE y4.why IS NOT NULL ORDER BY y4.ord LIMIT 50) y3), '[]'::jsonb),
         coalesce((SELECT jsonb_agg(jsonb_build_object('code', y5.acode, 'name', y5.name, 'unit', y5.unit, 'qty', y5.q) ORDER BY y5.ord)
                     FROM y y5), '[]'::jsonb)
    INTO v_err, v_bad, v_out;

  IF v_err IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', v_err, 'bad', v_bad);
  END IF;
  RETURN jsonb_build_object('ok', true, 'lines', v_out);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_parse_lines(jsonb, numeric, numeric, integer) IS
  'Validates article lines [{code, qty}] for the stock v2 writers: known articles, quantity in range, whole units for КОМ, no duplicates. Returns {ok, lines:[{code, name, unit, qty}]} or {ok:false, error, bad:[…]}. Internal. Migration 20260945000400.';

-- the cost of one article at an instant (MKD; on a tie the owner value wins)
CREATE OR REPLACE FUNCTION public.stock_v2_cost_at(p_article text, p_at timestamptz)
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT c.cost_mkd
  FROM public.stock_article_costs c
  WHERE c.article_code = p_article AND c.valid_from <= coalesce(p_at, now())
  ORDER BY c.valid_from DESC, (c.source = 'owner') DESC, c.recorded_at DESC
  LIMIT 1
$$;

COMMENT ON FUNCTION public.stock_v2_cost_at(text, timestamptz) IS
  'An article''s purchase cost (MKD excl. VAT) valid at p_at: the latest stock_article_costs row with valid_from ≤ p_at, the owner value first on a tie. OWNERS ONLY (callers strip it). Migration 20260945000400.';

-- ── 1. the configuration (StockConfig) ──────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_config()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'settings', public.stock_v2_settings(),
    'warehouses', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', w.id, 'code', w.code, 'name', w.name, 'role', w.role, 'tracked', w.tracked,
               'sellable', w.sellable, 'active', w.active, 'sigma_moves_from', w.sigma_moves_from,
               'sort', w.sort, 'note', w.note,
               'keys', coalesce((SELECT jsonb_agg(jsonb_build_object('system', k.system, 'key', k.key) ORDER BY k.system, k.key)
                                   FROM public.stock_warehouse_keys k WHERE k.warehouse_id = w.id), '[]'::jsonb))
             ORDER BY w.sort, w.code)
      FROM public.stock_warehouses w), '[]'::jsonb),
    'routes', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', r.id, 'priority', r.priority, 'match_account', r.match_account, 'match_series', r.match_series,
               'match_shape', r.match_shape,
               'warehouse', (SELECT w.code FROM public.stock_warehouses w WHERE w.id = r.warehouse_id),
               'return_warehouse', (SELECT w.code FROM public.stock_warehouses w WHERE w.id = r.return_warehouse_id),
               'valid_from', r.valid_from, 'valid_to', r.valid_to, 'active', r.active)
             ORDER BY r.priority, r.id)
      FROM public.stock_parcel_routes r), '[]'::jsonb),
    'sigma_rules', coalesce((
      SELECT jsonb_agg(jsonb_build_object('id', s.id, 'match', s.match, 'action', s.action, 'reason', s.reason,
                                          'active', s.active) ORDER BY s.id)
      FROM public.stock_sigma_rules s), '[]'::jsonb))
$$;

COMMENT ON FUNCTION public.stock_v2_config() IS
  'GET stock/v2/config: StockConfig = {settings, warehouses (+ keys), routes, sigma_rules}. Migration 20260945000400.';

-- ── 2. the switch and the settings ──────────────────────────────────────────
-- p_enabled NULL = unchanged. p_patch: free_units deduct|skip · stale_label_days 1–365 ·
-- relabel_window_days 0–30 · sigma{ingest, apply_on_ingest, costs_follow} · profit{cost_source legacy|sigma,
-- extra_goods}. Refuses ON while a warehouse a route ships from or returns to has no approved opening.
-- The api runs stock_v2_apply('switch_on') after switching on.
CREATE OR REPLACE FUNCTION public.stock_v2_set(p_enabled boolean, p_patch jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_patch  jsonb := coalesce(p_patch, '{}'::jsonb);
  v_before jsonb;
  v_after  jsonb;
  v_bad    text;
  v_missing jsonb;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_patch'); END IF;

  SELECT k INTO v_bad FROM jsonb_object_keys(v_patch) k
   WHERE k NOT IN ('free_units', 'stale_label_days', 'relabel_window_days', 'sigma', 'profit') LIMIT 1;
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_key', 'key', v_bad); END IF;
  IF v_patch ? 'free_units' AND coalesce(v_patch ->> 'free_units', '') NOT IN ('deduct', 'skip') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_free_units');
  END IF;
  IF v_patch ? 'stale_label_days' AND NOT (jsonb_typeof(v_patch -> 'stale_label_days') = 'number'
       AND (v_patch ->> 'stale_label_days')::numeric BETWEEN 1 AND 365
       AND (v_patch ->> 'stale_label_days')::numeric = trunc((v_patch ->> 'stale_label_days')::numeric)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_stale_label_days');
  END IF;
  IF v_patch ? 'relabel_window_days' AND NOT (jsonb_typeof(v_patch -> 'relabel_window_days') = 'number'
       AND (v_patch ->> 'relabel_window_days')::numeric BETWEEN 0 AND 30
       AND (v_patch ->> 'relabel_window_days')::numeric = trunc((v_patch ->> 'relabel_window_days')::numeric)) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_relabel_window_days');
  END IF;
  IF v_patch ? 'sigma' THEN
    IF jsonb_typeof(v_patch -> 'sigma') <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(v_patch -> 'sigma') e
                   WHERE e.key NOT IN ('ingest', 'apply_on_ingest', 'costs_follow') OR jsonb_typeof(e.value) <> 'boolean') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_sigma');
    END IF;
  END IF;
  IF v_patch ? 'profit' THEN
    IF jsonb_typeof(v_patch -> 'profit') <> 'object'
       OR EXISTS (SELECT 1 FROM jsonb_each(v_patch -> 'profit') e
                   WHERE NOT ((e.key = 'cost_source' AND e.value #>> '{}' IN ('legacy', 'sigma'))
                           OR (e.key = 'extra_goods' AND jsonb_typeof(e.value) = 'boolean'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_profit');
    END IF;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT a.value INTO v_before FROM public.app_settings a WHERE a.key = 'stock_v2' FOR UPDATE;
  v_before := coalesce(v_before, '{}'::jsonb);

  IF p_enabled THEN
    SELECT jsonb_agg(w.code ORDER BY w.code) INTO v_missing
      FROM public.stock_warehouses w
     WHERE w.tracked
       AND w.id IN (SELECT r.warehouse_id FROM public.stock_parcel_routes r WHERE r.active
                    UNION SELECT r.return_warehouse_id FROM public.stock_parcel_routes r
                     WHERE r.active AND r.return_warehouse_id IS NOT NULL)
       AND NOT EXISTS (SELECT 1 FROM public.stock_wh_counts c
                        WHERE c.warehouse_id = w.id AND c.kind = 'opening' AND c.status = 'approved');
    IF v_missing IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'error', 'no_opening', 'warehouses', v_missing);
    END IF;
  END IF;

  v_after := public.stock_v2_settings()
             || (v_patch - 'sigma' - 'profit')
             || jsonb_build_object(
                  'sigma', coalesce(public.stock_v2_settings() -> 'sigma', '{}'::jsonb) || coalesce(v_patch -> 'sigma', '{}'::jsonb),
                  'profit', coalesce(public.stock_v2_settings() -> 'profit', '{}'::jsonb) || coalesce(v_patch -> 'profit', '{}'::jsonb),
                  'changed_at', now(), 'changed_by', p_actor);
  IF p_enabled IS NOT NULL THEN
    v_after := v_after || jsonb_build_object('enabled', p_enabled);
    IF p_enabled AND coalesce(v_before ->> 'enabled', 'false') <> 'true' THEN
      v_after := v_after || jsonb_build_object('enabled_at', now());
    END IF;
  END IF;

  INSERT INTO public.app_settings (key, value, updated_by)
  VALUES ('stock_v2', v_after, p_actor)
  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by;

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.set', 'app_settings', 'stock_v2', 'stock_v2',
                                jsonb_build_object('enabled', p_enabled, 'patch', v_patch, 'before', v_before, 'after', v_after));
  RETURN jsonb_build_object('ok', true, 'before', v_before, 'after', v_after);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_set(boolean, jsonb, uuid) IS
  'The owners'' switch and settings of stock v2 (app_settings.stock_v2): validates the patch, refuses ON while a routed tracked warehouse has no approved opening, audits stock_v2.set. The api (owners) then runs stock_v2_apply(''switch_on''). Migration 20260945000400.';

-- ── 3. counts ───────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_count_save(
  p_warehouse      text,
  p_counted_at     timestamptz,
  p_kind           text,
  p_lines          jsonb,
  p_source         text,
  p_source_ref     text,
  p_packed_counted boolean,
  p_note           text,
  p_actor          uuid,
  p_is_owner       boolean,
  p_dry            boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
SET work_mem = '64MB'
SET jit = off
AS $fn$
DECLARE
  v_owner   boolean := coalesce(p_is_owner, false);
  v_dry     boolean := coalesce(p_dry, false);
  v_packed  boolean := coalesce(p_packed_counted, false);
  v_source  text := coalesce(nullif(btrim(p_source), ''), 'manual');
  v_note    text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
  v_wh      record;
  v_parsed  jsonb;
  v_last    timestamptz;
  v_status  text;
  v_count   uuid;
  v_warn    text[] := ARRAY[]::text[];
  v_n       integer;
  v_lines   jsonb;
  v_totals  jsonb;
  v_preview boolean := NOT public.stock_v2_enabled();
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT w.id, w.code, w.name, w.tracked INTO v_wh FROM public.stock_warehouses w WHERE w.code = lower(btrim(coalesce(p_warehouse, '')));
  IF v_wh.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_warehouse'); END IF;
  IF NOT v_wh.tracked THEN RETURN jsonb_build_object('ok', false, 'error', 'warehouse_not_tracked'); END IF;
  IF p_counted_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'counted_at_required'); END IF;
  IF p_counted_at > now() + interval '5 minutes' THEN RETURN jsonb_build_object('ok', false, 'error', 'counted_at_in_future'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('opening', 'full', 'partial') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_kind'); END IF;
  IF v_source NOT IN ('manual', 'sigma_variant', 'xlsx') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_source'); END IF;

  v_parsed := public.stock_v2_parse_lines(p_lines, 0, 10000000, 20000);
  IF NOT (v_parsed ->> 'ok')::boolean THEN RETURN v_parsed; END IF;

  IF NOT v_dry THEN
    PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  END IF;

  SELECT max(c.counted_at) INTO v_last
    FROM public.stock_wh_counts c WHERE c.warehouse_id = v_wh.id AND c.status = 'approved';
  IF NOT v_owner AND v_last IS NOT NULL AND p_counted_at <= v_last THEN
    RETURN jsonb_build_object('ok', false, 'error', 'before_last_count', 'last_count_at', v_last);
  END IF;
  IF p_kind = 'opening' THEN
    IF EXISTS (SELECT 1 FROM public.stock_wh_counts c
                WHERE c.warehouse_id = v_wh.id AND c.kind = 'opening' AND c.status = 'approved') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'opening_exists');
    END IF;
    IF EXISTS (SELECT 1 FROM public.stock_wh_counts c
                WHERE c.warehouse_id = v_wh.id AND c.status = 'approved' AND c.counted_at < p_counted_at) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'opening_not_first');
    END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM public.stock_wh_counts c
                     WHERE c.warehouse_id = v_wh.id AND c.kind = 'opening' AND c.status = 'approved') THEN
    v_warn := v_warn || 'no_opening'::text;
  END IF;

  -- warnings: parcels made around the count, an old count, articles a full count left out
  SELECT count(*) INTO v_n FROM public.mex_parcels p
   WHERE p.created_at_mex BETWEEN p_counted_at - interval '2 hours' AND p_counted_at + interval '2 hours';
  IF v_n > 0 THEN v_warn := v_warn || ('parcels_near_count:' || v_n); END IF;
  IF p_counted_at < now() - interval '30 days' THEN v_warn := v_warn || 'old_count'::text; END IF;
  IF NOT v_owner THEN v_warn := v_warn || 'pending_owner_approval'::text; END IF;

  -- what the system holds at the count time (the ledger, or the preview while stock v2 is off)
  WITH pos AS (
    SELECT x.article_code, x.on_hand, x.to_pack
    FROM public.stock_v2_position_at(p_counted_at, v_wh.code, v_preview) x
  ),
  ln AS (
    SELECT e ->> 'code' AS code, e ->> 'name' AS name, (e ->> 'qty')::numeric AS counted
    FROM jsonb_array_elements(v_parsed -> 'lines') e
  ),
  j AS (
    SELECT ln.code, ln.name, ln.counted,
           coalesce(pos.on_hand, 0) + CASE WHEN v_packed THEN coalesce(pos.to_pack, 0) ELSE 0 END AS sys,
           CASE WHEN v_owner THEN public.stock_v2_cost_at(ln.code, p_counted_at) END AS cost
    FROM ln LEFT JOIN pos ON pos.article_code = ln.code
  )
  SELECT coalesce(jsonb_agg(jsonb_build_object(
           'code', j.code, 'name', j.name, 'system_qty', j.sys, 'counted_qty', j.counted, 'diff', j.counted - j.sys)
           || CASE WHEN v_owner THEN jsonb_build_object('value_diff_mkd', round((j.counted - j.sys) * j.cost, 2)) ELSE '{}'::jsonb END
           ORDER BY abs(j.counted - j.sys) DESC, j.code), '[]'::jsonb),
         jsonb_build_object('lines', count(*), 'system_qty', coalesce(sum(j.sys), 0),
                            'counted_qty', coalesce(sum(j.counted), 0), 'diff', coalesce(sum(j.counted - j.sys), 0))
         || CASE WHEN v_owner THEN jsonb_build_object('value_diff_mkd', round(sum((j.counted - j.sys) * j.cost), 2)) ELSE '{}'::jsonb END
    INTO v_lines, v_totals
    FROM j;

  IF p_kind = 'full' THEN
    SELECT count(*) INTO v_n
      FROM public.stock_v2_position_at(p_counted_at, v_wh.code, v_preview) x
     WHERE x.on_hand <> 0
       AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_parsed -> 'lines') e WHERE e ->> 'code' = x.article_code);
    IF v_n > 0 THEN v_warn := v_warn || ('not_counted:' || v_n); END IF;
  END IF;

  IF v_dry THEN
    RETURN jsonb_build_object('ok', true, 'dry', true, 'preview', v_preview, 'warnings', to_jsonb(v_warn),
                              'lines', v_lines, 'totals', v_totals);
  END IF;

  v_status := CASE WHEN v_owner THEN 'approved' ELSE 'pending' END;
  PERFORM set_config('elyon.stock_write', 'on', true);
  INSERT INTO public.stock_wh_counts
    (warehouse_id, counted_at, kind, source, source_ref, status, packed_counted, note, created_by,
     approved_by, approved_at)
  VALUES (v_wh.id, p_counted_at, p_kind, v_source, nullif(left(btrim(coalesce(p_source_ref, '')), 300), ''),
          v_status, v_packed, v_note, p_actor,
          CASE WHEN v_owner THEN p_actor END, CASE WHEN v_owner THEN now() END)
  RETURNING id INTO v_count;
  INSERT INTO public.stock_wh_count_lines (count_id, article_code, counted_qty, system_qty_at_save)
  SELECT v_count, e ->> 'code', (e ->> 'counted_qty')::numeric, (e ->> 'system_qty')::numeric
  FROM jsonb_array_elements(v_lines) e
  ORDER BY e ->> 'code';
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.count_save', 'stock_wh_counts', v_count::text, v_wh.code,
    jsonb_build_object('warehouse', v_wh.code, 'counted_at', p_counted_at, 'kind', p_kind, 'source', v_source,
                       'source_ref', p_source_ref, 'status', v_status, 'packed_counted', v_packed, 'note', v_note,
                       'warnings', to_jsonb(v_warn), 'totals', v_totals - 'value_diff_mkd'));

  RETURN jsonb_build_object('ok', true, 'dry', false, 'count_id', v_count, 'status', v_status, 'preview', v_preview,
                            'warnings', to_jsonb(v_warn), 'lines', v_lines, 'totals', v_totals);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_count_save(text, timestamptz, text, jsonb, text, text, boolean, text, uuid, boolean, boolean) IS
  'POST stock/v2/count (owners / admin / warehouse): previews (p_dry) or saves one count of a tracked warehouse — StockCountResult {dry, count_id, status, warnings, lines[{code, name, system_qty, counted_qty, diff, value_diff_mkd (owners)}], totals}. An owner''s count is approved at once; anyone else''s is pending and may not be dated at or before the last approved count. One approved opening per warehouse, the earliest. Audited stock_v2.count_save. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.stock_v2_count_approve(p_count uuid, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_c record;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT c.*, w.code AS wh_code INTO v_c
    FROM public.stock_wh_counts c JOIN public.stock_warehouses w ON w.id = c.warehouse_id
   WHERE c.id = p_count FOR UPDATE OF c;
  IF v_c.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_c.status <> 'pending' THEN RETURN jsonb_build_object('ok', false, 'error', 'not_pending', 'status', v_c.status); END IF;
  IF v_c.kind = 'opening' THEN
    IF EXISTS (SELECT 1 FROM public.stock_wh_counts c
                WHERE c.warehouse_id = v_c.warehouse_id AND c.kind = 'opening' AND c.status = 'approved') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'opening_exists');
    END IF;
    IF EXISTS (SELECT 1 FROM public.stock_wh_counts c
                WHERE c.warehouse_id = v_c.warehouse_id AND c.status = 'approved' AND c.counted_at < v_c.counted_at) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'opening_not_first');
    END IF;
  END IF;

  PERFORM set_config('elyon.stock_write', 'on', true);
  UPDATE public.stock_wh_counts SET status = 'approved', approved_by = p_actor, approved_at = now() WHERE id = p_count;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.count_approve', 'stock_wh_counts', p_count::text, v_c.wh_code,
    jsonb_build_object('warehouse', v_c.wh_code, 'counted_at', v_c.counted_at, 'kind', v_c.kind,
                       'created_by', v_c.created_by));
  RETURN jsonb_build_object('ok', true, 'count_id', p_count, 'status', 'approved');
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_count_approve(uuid, uuid) IS
  'POST stock/v2/count/:id/approve (owners): a pending count becomes approved (and moves the ledger on the next run). Audited stock_v2.count_approve. Addition to the contract. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.stock_v2_count_void(p_count uuid, p_reason text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_c      record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 OR length(v_reason) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'reason_required');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT c.*, w.code AS wh_code INTO v_c
    FROM public.stock_wh_counts c JOIN public.stock_warehouses w ON w.id = c.warehouse_id
   WHERE c.id = p_count FOR UPDATE OF c;
  IF v_c.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_c.status = 'void' THEN RETURN jsonb_build_object('ok', false, 'error', 'already_void'); END IF;

  PERFORM set_config('elyon.stock_write', 'on', true);
  UPDATE public.stock_wh_counts
     SET status = 'void', voided_by = p_actor, voided_at = now(), void_reason = v_reason
   WHERE id = p_count;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.count_void', 'stock_wh_counts', p_count::text, v_c.wh_code,
    jsonb_build_object('warehouse', v_c.wh_code, 'counted_at', v_c.counted_at, 'kind', v_c.kind,
                       'was', v_c.status, 'reason', v_reason));
  RETURN jsonb_build_object('ok', true, 'count_id', p_count, 'status', 'void', 'was', v_c.status);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_count_void(uuid, text, uuid) IS
  'POST stock/v2/count/:id/void: a count stops counting (an applied one is negated by the next run as corrections). Reason required. Audited stock_v2.count_void. Migration 20260945000400.';

-- ── 4. manual moves ─────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_v2_manual_move(
  p_kind     text,
  p_from     text,
  p_to       text,
  p_event_at timestamptz,
  p_lines    jsonb,
  p_doc_ref  text,
  p_note     text,
  p_actor    uuid,
  p_dry      boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_from   record;
  v_to     record;
  v_parsed jsonb;
  v_move   uuid;
  v_to_code text := nullif(lower(btrim(coalesce(p_to, ''))), '');
  v_note   text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF p_kind IS NULL OR p_kind NOT IN ('receipt', 'transfer', 'adjust', 'writeoff', 'damaged', 'unpack') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_kind');
  END IF;
  IF p_event_at IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'event_at_required'); END IF;
  IF p_event_at > now() + interval '5 minutes' THEN RETURN jsonb_build_object('ok', false, 'error', 'event_at_in_future'); END IF;
  IF v_note IS NULL OR length(v_note) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'note_required'); END IF;
  IF p_kind = 'damaged' AND v_to_code IS NULL THEN v_to_code := 'damaged'; END IF;
  IF p_kind = 'unpack' AND v_to_code IS NULL THEN v_to_code := 'main'; END IF;

  SELECT w.id, w.code, w.tracked INTO v_from FROM public.stock_warehouses w WHERE w.code = nullif(lower(btrim(coalesce(p_from, ''))), '');
  SELECT w.id, w.code, w.tracked INTO v_to   FROM public.stock_warehouses w WHERE w.code = v_to_code;
  IF nullif(btrim(coalesce(p_from, '')), '') IS NOT NULL AND v_from.id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'unknown_from');
  END IF;
  IF v_to_code IS NOT NULL AND v_to.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_to'); END IF;

  IF (p_kind IN ('receipt', 'unpack') AND (v_to.id IS NULL OR v_from.id IS NOT NULL))
     OR (p_kind IN ('transfer', 'damaged') AND (v_from.id IS NULL OR v_to.id IS NULL OR v_from.id = v_to.id))
     OR (p_kind = 'writeoff' AND (v_from.id IS NULL OR v_to.id IS NOT NULL))
     OR (p_kind = 'adjust' AND ((v_from.id IS NULL) = (v_to.id IS NULL))) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_sides');
  END IF;
  IF NOT coalesce(v_from.tracked, false) AND NOT coalesce(v_to.tracked, false) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'no_tracked_side');
  END IF;

  v_parsed := public.stock_v2_parse_lines(p_lines, 0.001, 1000000, 2000);
  IF NOT (v_parsed ->> 'ok')::boolean THEN RETURN v_parsed; END IF;

  IF coalesce(p_dry, false) THEN
    RETURN jsonb_build_object('ok', true, 'dry', true,
                              'preview', jsonb_build_object('kind', p_kind, 'from', v_from.code, 'to', v_to.code,
                                                            'event_at', p_event_at, 'lines', v_parsed -> 'lines'));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  PERFORM set_config('elyon.stock_write', 'on', true);
  INSERT INTO public.stock_manual_moves (kind, from_wh, to_wh, event_at, doc_ref, note, status, created_by)
  VALUES (p_kind, v_from.id, v_to.id, p_event_at, nullif(left(btrim(coalesce(p_doc_ref, '')), 200), ''), v_note,
          'approved', p_actor)
  RETURNING id INTO v_move;
  INSERT INTO public.stock_manual_move_lines (move_id, article_code, qty)
  SELECT v_move, e ->> 'code', (e ->> 'qty')::numeric FROM jsonb_array_elements(v_parsed -> 'lines') e;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.manual_move', 'stock_manual_moves', v_move::text, p_kind,
    jsonb_build_object('kind', p_kind, 'from', v_from.code, 'to', v_to.code, 'event_at', p_event_at,
                       'doc_ref', p_doc_ref, 'note', v_note, 'lines', v_parsed -> 'lines'));
  RETURN jsonb_build_object('ok', true, 'dry', false, 'move_id', v_move);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_manual_move(text, text, text, timestamptz, jsonb, text, text, uuid, boolean) IS
  'POST stock/v2/move: one manual move (receipt → to · transfer from → to · adjust one side · writeoff from · damaged from → damaged · unpack → to (default main)); a note is required; p_dry previews. Moves the ledger on the next run (only tracked sides). Audited stock_v2.manual_move. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.stock_v2_manual_move_void(p_move uuid, p_reason text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_m      record;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF v_reason IS NULL OR length(v_reason) < 5 THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;
  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT m.* INTO v_m FROM public.stock_manual_moves m WHERE m.id = p_move FOR UPDATE;
  IF v_m.id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found'); END IF;
  IF v_m.status = 'void' THEN RETURN jsonb_build_object('ok', false, 'error', 'already_void'); END IF;
  PERFORM set_config('elyon.stock_write', 'on', true);
  UPDATE public.stock_manual_moves SET status = 'void', voided_by = p_actor, voided_at = now() WHERE id = p_move;
  PERFORM set_config('elyon.stock_write', 'off', true);
  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.manual_move_void', 'stock_manual_moves', p_move::text, v_m.kind,
    jsonb_build_object('reason', left(v_reason, 500), 'kind', v_m.kind, 'event_at', v_m.event_at));
  RETURN jsonb_build_object('ok', true, 'move_id', p_move, 'status', 'void');
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_manual_move_void(uuid, text, uuid) IS
  'Voids a manual move (the next run negates it as corrections). Reason required. Audited stock_v2.manual_move_void. Addition to the contract. Migration 20260945000400.';

-- ── 5. parcel overrides ─────────────────────────────────────────────────────
-- p_action exclude | lines (payload.lines [{code, qty}]) | route (payload.warehouse / return_warehouse) |
-- unpacked (payload.event_at, default now) | damaged_return (payload.warehouse, default damaged) | clear.
CREATE OR REPLACE FUNCTION public.stock_v2_parcel_override(p_tracking text, p_action text, p_payload jsonb, p_note text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_tr      text := btrim(coalesce(p_tracking, ''));
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_note    text := nullif(left(btrim(coalesce(p_note, '')), 1000), '');
  v_parcel  record;
  v_before  jsonb;
  v_parsed  jsonb;
  v_event   timestamptz;
  v_clean   jsonb := '{}'::jsonb;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF p_action IS NULL OR p_action NOT IN ('exclude', 'lines', 'route', 'unpacked', 'damaged_return', 'clear') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_action');
  END IF;
  IF v_note IS NULL OR length(v_note) < 3 THEN RETURN jsonb_build_object('ok', false, 'error', 'note_required'); END IF;
  IF jsonb_typeof(v_payload) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_payload'); END IF;
  SELECT p.tracking_id, p.created_at_mex INTO v_parcel FROM public.mex_parcels p WHERE p.tracking_id = v_tr;
  IF v_parcel.tracking_id IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_parcel'); END IF;

  IF p_action = 'lines' THEN
    v_parsed := public.stock_v2_parse_lines(v_payload -> 'lines', 0.001, 1000, 200);
    IF NOT (v_parsed ->> 'ok')::boolean THEN RETURN v_parsed; END IF;
    SELECT jsonb_build_object('lines', jsonb_agg(jsonb_build_object('code', e ->> 'code', 'qty', (e ->> 'qty')::numeric)))
      INTO v_clean FROM jsonb_array_elements(v_parsed -> 'lines') e;
  ELSIF p_action = 'route' THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.tracked AND w.code = lower(v_payload ->> 'warehouse'))
       AND NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.tracked AND w.code = lower(v_payload ->> 'return_warehouse')) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_route');
    END IF;
    IF (v_payload ? 'warehouse' AND NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.tracked AND w.code = lower(v_payload ->> 'warehouse')))
       OR (v_payload ? 'return_warehouse' AND NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.tracked AND w.code = lower(v_payload ->> 'return_warehouse'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_route');
    END IF;
    v_clean := jsonb_strip_nulls(jsonb_build_object('warehouse', lower(v_payload ->> 'warehouse'),
                                                    'return_warehouse', lower(v_payload ->> 'return_warehouse')));
  ELSIF p_action = 'unpacked' THEN
    v_event := coalesce(public.stock_ts(v_payload ->> 'event_at'), now());
    IF v_event < v_parcel.created_at_mex OR v_event > now() + interval '5 minutes' THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_event_at');
    END IF;
  ELSIF p_action = 'damaged_return' THEN
    IF NOT EXISTS (SELECT 1 FROM public.stock_warehouses w
                    WHERE w.tracked AND w.code = lower(coalesce(v_payload ->> 'warehouse', 'damaged'))) THEN
      RETURN jsonb_build_object('ok', false, 'error', 'bad_route');
    END IF;
    v_clean := jsonb_build_object('warehouse', lower(coalesce(v_payload ->> 'warehouse', 'damaged')));
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  SELECT to_jsonb(o) INTO v_before FROM public.stock_parcel_overrides o WHERE o.tracking_id = v_tr FOR UPDATE;

  PERFORM set_config('elyon.stock_write', 'on', true);
  IF p_action = 'clear' THEN
    IF v_before IS NULL THEN
      PERFORM set_config('elyon.stock_write', 'off', true);
      RETURN jsonb_build_object('ok', false, 'error', 'no_override');
    END IF;
    UPDATE public.stock_parcel_overrides SET active = false, note = v_note, set_by = p_actor, set_at = now()
     WHERE tracking_id = v_tr;
  ELSE
    INSERT INTO public.stock_parcel_overrides (tracking_id, action, payload, event_at, active, note, set_by, set_at)
    VALUES (v_tr, p_action, v_clean, v_event, true, v_note, p_actor, now())
    ON CONFLICT (tracking_id) DO UPDATE SET
      action = EXCLUDED.action, payload = EXCLUDED.payload, event_at = EXCLUDED.event_at, active = true,
      note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  END IF;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.parcel_override', 'stock_parcel_overrides', v_tr, p_action,
    jsonb_build_object('action', p_action, 'payload', v_clean, 'event_at', v_event, 'note', v_note, 'before', v_before));
  RETURN jsonb_build_object('ok', true, 'tracking_id', v_tr, 'action', p_action, 'payload', v_clean, 'event_at', v_event);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_parcel_override(text, text, jsonb, text, uuid) IS
  'POST stock/v2/parcel-override (owners): one ruling per parcel — exclude · lines · route · unpacked · damaged_return, or clear (deactivates). A note is required. Audited stock_v2.parcel_override. Migration 20260945000400.';

-- ── 6. configuration: warehouses, keys, routes, Sigma rules ─────────────────
-- p_patch = {warehouses:[{code, name?, role?, tracked?, sellable?, sigma_moves_from?, active?, sort?, note?}],
--            keys:[{system, key, warehouse: code | null (= remove)}],
--            routes:[{id?, priority, match_account, match_series, match_shape, warehouse, return_warehouse,
--                     valid_from, valid_to, active}],
--            sigma_rules:[{id?, match, action, reason, active}]}
-- A changed route / warehouse re-routes history on the next run (as corrections).
CREATE OR REPLACE FUNCTION public.stock_v2_config_set(p_patch jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_patch  jsonb := coalesce(p_patch, '{}'::jsonb);
  v_before jsonb;
  v_after  jsonb;
  v_bad    text;
  e        jsonb;
  v_wh     smallint;
  v_rwh    smallint;
  v_id     integer;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF jsonb_typeof(v_patch) <> 'object' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_patch'); END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(v_patch) k WHERE k NOT IN ('warehouses', 'keys', 'routes', 'sigma_rules') LIMIT 1;
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_key', 'key', v_bad); END IF;
  SELECT k INTO v_bad FROM jsonb_object_keys(v_patch) k WHERE jsonb_typeof(v_patch -> k) <> 'array' LIMIT 1;
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'not_an_array', 'key', v_bad); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  v_before := public.stock_v2_config();
  PERFORM set_config('elyon.stock_write', 'on', true);

  -- warehouses
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_patch -> 'warehouses', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'code', '') !~ '^[a-z0-9_]{2,24}$' THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad warehouse %', e USING ERRCODE = '22023';
    END IF;
    IF e ? 'role' AND e ->> 'role' NOT IN ('main', 'shipping', 'lab', 'damaged', 'writeoff', 'plant', 'review', 'other') THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad role %', e ->> 'role' USING ERRCODE = '22023';
    END IF;
    IF e ? 'sigma_moves_from' AND e ->> 'sigma_moves_from' IS NOT NULL AND public.stock_ts(e ->> 'sigma_moves_from') IS NULL THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad sigma_moves_from %', e ->> 'sigma_moves_from' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.code = e ->> 'code') THEN
      UPDATE public.stock_warehouses w SET
        name             = CASE WHEN e ? 'name' THEN coalesce(nullif(btrim(e ->> 'name'), ''), w.name) ELSE w.name END,
        role             = CASE WHEN e ? 'role' THEN e ->> 'role' ELSE w.role END,
        tracked          = CASE WHEN e ? 'tracked' THEN (e ->> 'tracked')::boolean ELSE w.tracked END,
        sellable         = CASE WHEN e ? 'sellable' THEN (e ->> 'sellable')::boolean ELSE w.sellable END,
        sigma_moves_from = CASE WHEN e ? 'sigma_moves_from' THEN public.stock_ts(e ->> 'sigma_moves_from') ELSE w.sigma_moves_from END,
        active           = CASE WHEN e ? 'active' THEN (e ->> 'active')::boolean ELSE w.active END,
        sort             = CASE WHEN e ? 'sort' THEN (e ->> 'sort')::integer ELSE w.sort END,
        note             = CASE WHEN e ? 'note' THEN nullif(btrim(e ->> 'note'), '') ELSE w.note END
      WHERE w.code = e ->> 'code';
    ELSE
      IF nullif(btrim(coalesce(e ->> 'name', '')), '') IS NULL OR NOT e ? 'role' THEN
        RAISE EXCEPTION 'stock_v2_config_set: a new warehouse needs name and role' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.stock_warehouses (code, name, role, tracked, sellable, sigma_moves_from, active, sort, note)
      VALUES (e ->> 'code', btrim(e ->> 'name'), e ->> 'role', coalesce((e ->> 'tracked')::boolean, false),
              coalesce((e ->> 'sellable')::boolean, false), public.stock_ts(e ->> 'sigma_moves_from'),
              coalesce((e ->> 'active')::boolean, true), coalesce((e ->> 'sort')::integer, 100),
              nullif(btrim(coalesce(e ->> 'note', '')), ''));
    END IF;
  END LOOP;

  -- keys
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_patch -> 'keys', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' OR coalesce(e ->> 'system', '') NOT IN ('sigma', 'collabbox')
       OR nullif(btrim(coalesce(e ->> 'key', '')), '') IS NULL THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad key %', e USING ERRCODE = '22023';
    END IF;
    IF e ->> 'warehouse' IS NULL THEN
      DELETE FROM public.stock_warehouse_keys k WHERE k.system = e ->> 'system' AND k.key = btrim(e ->> 'key');
    ELSE
      v_wh := public.stock_v2_wh(e ->> 'warehouse');
      IF v_wh IS NULL THEN RAISE EXCEPTION 'stock_v2_config_set: unknown warehouse %', e ->> 'warehouse' USING ERRCODE = '22023'; END IF;
      INSERT INTO public.stock_warehouse_keys (system, key, warehouse_id) VALUES (e ->> 'system', btrim(e ->> 'key'), v_wh)
      ON CONFLICT (system, key) DO UPDATE SET warehouse_id = EXCLUDED.warehouse_id;
    END IF;
  END LOOP;

  -- routes
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_patch -> 'routes', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'stock_v2_config_set: bad route %', e USING ERRCODE = '22023'; END IF;
    v_wh := CASE WHEN e ? 'warehouse' THEN public.stock_v2_wh(e ->> 'warehouse') END;
    v_rwh := CASE WHEN e ->> 'return_warehouse' IS NOT NULL THEN public.stock_v2_wh(e ->> 'return_warehouse') END;
    IF e ? 'warehouse' AND (v_wh IS NULL OR NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.id = v_wh AND w.tracked)) THEN
      RAISE EXCEPTION 'stock_v2_config_set: a route ships from a tracked warehouse (%)', e ->> 'warehouse' USING ERRCODE = '22023';
    END IF;
    IF e ->> 'return_warehouse' IS NOT NULL AND (v_rwh IS NULL OR NOT EXISTS (SELECT 1 FROM public.stock_warehouses w WHERE w.id = v_rwh AND w.tracked)) THEN
      RAISE EXCEPTION 'stock_v2_config_set: a route returns to a tracked warehouse (%)', e ->> 'return_warehouse' USING ERRCODE = '22023';
    END IF;
    IF e ? 'match_account' AND e ->> 'match_account' IS NOT NULL AND e ->> 'match_account' NOT IN ('natura', 'bio_natural') THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad match_account' USING ERRCODE = '22023';
    END IF;
    IF e ? 'match_shape' AND e ->> 'match_shape' IS NOT NULL AND e ->> 'match_shape' NOT IN ('collabbox', 'web', 'crm', 'other') THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad match_shape' USING ERRCODE = '22023';
    END IF;
    IF e ? 'valid_from' AND public.stock_ts(e ->> 'valid_from') IS NULL THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad valid_from' USING ERRCODE = '22023';
    END IF;
    IF e ->> 'valid_to' IS NOT NULL AND public.stock_ts(e ->> 'valid_to') IS NULL THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad valid_to' USING ERRCODE = '22023';
    END IF;
    v_id := CASE WHEN jsonb_typeof(e -> 'id') = 'number' THEN (e ->> 'id')::integer END;
    IF v_id IS NOT NULL THEN
      UPDATE public.stock_parcel_routes r SET
        priority            = CASE WHEN e ? 'priority' THEN (e ->> 'priority')::integer ELSE r.priority END,
        match_account       = CASE WHEN e ? 'match_account' THEN e ->> 'match_account' ELSE r.match_account END,
        match_series        = CASE WHEN e ? 'match_series' THEN nullif(btrim(e ->> 'match_series'), '') ELSE r.match_series END,
        match_shape         = CASE WHEN e ? 'match_shape' THEN e ->> 'match_shape' ELSE r.match_shape END,
        warehouse_id        = coalesce(v_wh, r.warehouse_id),
        return_warehouse_id = CASE WHEN e ? 'return_warehouse' THEN v_rwh ELSE r.return_warehouse_id END,
        valid_from          = CASE WHEN e ? 'valid_from' THEN public.stock_ts(e ->> 'valid_from') ELSE r.valid_from END,
        valid_to            = CASE WHEN e ? 'valid_to' THEN public.stock_ts(e ->> 'valid_to') ELSE r.valid_to END,
        active              = CASE WHEN e ? 'active' THEN (e ->> 'active')::boolean ELSE r.active END
      WHERE r.id = v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'stock_v2_config_set: unknown route %', v_id USING ERRCODE = '22023'; END IF;
    ELSE
      IF v_wh IS NULL OR NOT e ? 'priority' OR NOT e ? 'valid_from' THEN
        RAISE EXCEPTION 'stock_v2_config_set: a new route needs priority, warehouse and valid_from' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.stock_parcel_routes
        (priority, match_account, match_series, match_shape, warehouse_id, return_warehouse_id, valid_from, valid_to, active)
      VALUES ((e ->> 'priority')::integer, e ->> 'match_account', nullif(btrim(coalesce(e ->> 'match_series', '')), ''),
              e ->> 'match_shape', v_wh, v_rwh, public.stock_ts(e ->> 'valid_from'), public.stock_ts(e ->> 'valid_to'),
              coalesce((e ->> 'active')::boolean, true));
    END IF;
  END LOOP;

  -- Sigma rules
  FOR e IN SELECT x FROM jsonb_array_elements(coalesce(v_patch -> 'sigma_rules', '[]'::jsonb)) x LOOP
    IF jsonb_typeof(e) <> 'object' THEN RAISE EXCEPTION 'stock_v2_config_set: bad sigma rule %', e USING ERRCODE = '22023'; END IF;
    IF e ? 'match' AND (jsonb_typeof(e -> 'match') <> 'object'
                        OR NOT (e -> 'match' ?| ARRAY['client_code', 'doc_type', 'doc_key', 'objects'])) THEN
      RAISE EXCEPTION 'stock_v2_config_set: a rule matches client_code, doc_type, doc_key or objects' USING ERRCODE = '22023';
    END IF;
    IF e ? 'action' AND e ->> 'action' NOT IN ('exclude', 'include') THEN
      RAISE EXCEPTION 'stock_v2_config_set: bad rule action' USING ERRCODE = '22023';
    END IF;
    v_id := CASE WHEN jsonb_typeof(e -> 'id') = 'number' THEN (e ->> 'id')::integer END;
    IF v_id IS NOT NULL THEN
      UPDATE public.stock_sigma_rules s SET
        match  = CASE WHEN e ? 'match' THEN e -> 'match' ELSE s.match END,
        action = CASE WHEN e ? 'action' THEN e ->> 'action' ELSE s.action END,
        reason = CASE WHEN e ? 'reason' THEN coalesce(nullif(btrim(e ->> 'reason'), ''), s.reason) ELSE s.reason END,
        active = CASE WHEN e ? 'active' THEN (e ->> 'active')::boolean ELSE s.active END,
        set_by = p_actor, set_at = now()
      WHERE s.id = v_id;
      IF NOT FOUND THEN RAISE EXCEPTION 'stock_v2_config_set: unknown sigma rule %', v_id USING ERRCODE = '22023'; END IF;
    ELSE
      IF NOT e ? 'match' OR NOT e ? 'action' OR nullif(btrim(coalesce(e ->> 'reason', '')), '') IS NULL THEN
        RAISE EXCEPTION 'stock_v2_config_set: a new sigma rule needs match, action and reason' USING ERRCODE = '22023';
      END IF;
      INSERT INTO public.stock_sigma_rules (match, action, reason, active, set_by)
      VALUES (e -> 'match', e ->> 'action', btrim(e ->> 'reason'), coalesce((e ->> 'active')::boolean, true), p_actor);
    END IF;
  END LOOP;

  PERFORM set_config('elyon.stock_write', 'off', true);
  v_after := public.stock_v2_config();
  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.config_set', 'stock_v2', NULL, 'stock v2 configuration',
    jsonb_build_object('patch', v_patch, 'before', v_before - 'settings', 'after', v_after - 'settings'));
  RETURN jsonb_build_object('ok', true, 'config', v_after);
END
$fn$;

COMMENT ON FUNCTION public.stock_v2_config_set(jsonb, uuid) IS
  'PUT stock/v2/config (owners): warehouses, warehouse keys, parcel routes and Sigma rules in one audited call (stock_v2.config_set); an invalid entry raises 22023 and nothing is written. Migration 20260945000400.';

-- ── 7. articles and kits ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.stock_articles_upsert(p_rows jsonb, p_source text, p_actor uuid, p_dry boolean)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_source text := coalesce(nullif(btrim(p_source), ''), 'sigma');
  v_res    jsonb;
  v_ins    integer := 0;
  v_upd    integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF v_source NOT IN ('sigma', 'local') THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_source'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'rows_required'); END IF;
  IF jsonb_array_length(p_rows) > 20000 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many_rows'); END IF;

  DROP TABLE IF EXISTS pg_temp._stock_articles_in;
  CREATE TEMP TABLE _stock_articles_in ON COMMIT DROP AS
  WITH x AS (
    SELECT e.ord, upper(btrim(coalesce(e.v ->> 'code', ''))) AS code,
           nullif(btrim(coalesce(e.v ->> 'name', '')), '') AS name,
           coalesce(nullif(btrim(e.v ->> 'unit'), ''), 'КОМ') AS unit,
           nullif(btrim(coalesce(e.v ->> 'sigma_class', '')), '') AS sigma_class,
           nullif(btrim(coalesce(e.v ->> 'brand', '')), '') AS brand,
           coalesce(CASE WHEN jsonb_typeof(e.v -> 'is_set') = 'boolean' THEN (e.v ->> 'is_set')::boolean END, false) AS is_set,
           coalesce(CASE WHEN jsonb_typeof(e.v -> 'active') = 'boolean' THEN (e.v ->> 'active')::boolean END, true) AS active,
           jsonb_typeof(e.v) AS t
    FROM jsonb_array_elements(p_rows) WITH ORDINALITY AS e(v, ord)
  )
  SELECT x.*,
         CASE WHEN x.t <> 'object' THEN 'bad_row'
              WHEN NOT (x.code ~ '^[0-9]{6}$' OR x.code ~ '^L[0-9]{5}$') THEN 'bad_code'
              WHEN x.name IS NULL THEN 'name_required'
              WHEN count(*) OVER (PARTITION BY x.code) > 1 THEN 'duplicate_code'
         END AS why
  FROM x;

  SELECT jsonb_build_object(
           'rows', count(*),
           'invalid_count', count(*) FILTER (WHERE i.why IS NOT NULL),
           'invalid', coalesce((SELECT jsonb_agg(jsonb_build_object('row', z.ord, 'code', z.code, 'why', z.why) ORDER BY z.ord)
                                  FROM (SELECT * FROM pg_temp._stock_articles_in y WHERE y.why IS NOT NULL ORDER BY y.ord LIMIT 50) z), '[]'::jsonb),
           'new', count(*) FILTER (WHERE i.why IS NULL AND a.code IS NULL),
           'changed', count(*) FILTER (WHERE i.why IS NULL AND a.code IS NOT NULL
                                         AND (a.name, a.unit, a.sigma_class, a.brand, a.is_set, a.active)
                                             IS DISTINCT FROM (i.name, i.unit, i.sigma_class, i.brand, i.is_set, i.active)),
           'unchanged', count(*) FILTER (WHERE i.why IS NULL AND a.code IS NOT NULL
                                           AND (a.name, a.unit, a.sigma_class, a.brand, a.is_set, a.active)
                                               IS NOT DISTINCT FROM (i.name, i.unit, i.sigma_class, i.brand, i.is_set, i.active)))
    INTO v_res
    FROM pg_temp._stock_articles_in i
    LEFT JOIN public.stock_articles a ON a.code = i.code;

  IF coalesce(p_dry, false) THEN
    RETURN jsonb_build_object('ok', true, 'dry', true) || v_res;
  END IF;

  PERFORM set_config('elyon.stock_write', 'on', true);
  INSERT INTO public.stock_articles (code, name, unit, sigma_class, brand, is_set, active, source, last_seen_export)
  SELECT i.code, i.name, i.unit, i.sigma_class, i.brand, i.is_set, i.active, v_source,
         CASE WHEN v_source = 'sigma' THEN now() END
  FROM pg_temp._stock_articles_in i
  WHERE i.why IS NULL AND NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = i.code)
  ORDER BY i.code;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  UPDATE public.stock_articles a
     SET name = i.name, unit = i.unit, sigma_class = i.sigma_class, brand = i.brand, is_set = i.is_set,
         active = i.active, source = v_source,
         last_seen_export = CASE WHEN v_source = 'sigma' THEN now() ELSE a.last_seen_export END,
         updated_at = now()
    FROM pg_temp._stock_articles_in i
   WHERE a.code = i.code AND i.why IS NULL
     AND ((a.name, a.unit, a.sigma_class, a.brand, a.is_set, a.active, a.source)
          IS DISTINCT FROM (i.name, i.unit, i.sigma_class, i.brand, i.is_set, i.active, v_source)
          OR v_source = 'sigma');
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.articles_upsert', 'stock_articles', NULL, v_source,
    v_res || jsonb_build_object('inserted', v_ins, 'updated', v_upd));
  RETURN jsonb_build_object('ok', true, 'dry', false, 'inserted', v_ins, 'updated', v_upd) || v_res;
END
$fn$;

COMMENT ON FUNCTION public.stock_articles_upsert(jsonb, text, uuid, boolean) IS
  'Loads stock articles [{code, name, unit, sigma_class, brand, is_set, active}] (Sigma items or local L-codes): new rows inserted, changed rows updated, invalid rows listed and skipped; p_dry previews. Audited stock_v2.articles_upsert. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.stock_article_kits_upsert(p_rows jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_bad   jsonb;
  v_kits  integer := 0;
  v_rows  integer := 0;
  v_del   integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'rows_required'); END IF;

  DROP TABLE IF EXISTS pg_temp._stock_kits_in;
  CREATE TEMP TABLE _stock_kits_in ON COMMIT DROP AS
  SELECT upper(btrim(k.v ->> 'kit_code')) AS kit_code, upper(btrim(c.v ->> 'code')) AS component_code,
         CASE WHEN jsonb_typeof(c.v -> 'qty') = 'number' THEN (c.v ->> 'qty')::numeric ELSE public.stock_v2_num(c.v ->> 'qty') END AS qty,
         nullif(btrim(coalesce(k.v ->> 'source_ref', '')), '') AS source_ref,
         public.stock_ts(k.v ->> 'observed_at') AS observed_at
  FROM jsonb_array_elements(p_rows) k(v)
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(k.v -> 'components') = 'array' THEN k.v -> 'components' ELSE '[]'::jsonb END) c(v);

  SELECT jsonb_agg(jsonb_build_object('kit_code', i.kit_code, 'code', i.component_code, 'qty', i.qty))
    INTO v_bad
    FROM pg_temp._stock_kits_in i
   WHERE i.qty IS NULL OR i.qty <= 0 OR i.qty > 1000 OR i.kit_code = i.component_code
      OR NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = i.kit_code)
      OR NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = i.component_code);
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_components', 'bad', v_bad); END IF;

  PERFORM set_config('elyon.stock_write', 'on', true);
  DELETE FROM public.stock_article_kits k
   WHERE k.kit_code IN (SELECT DISTINCT i.kit_code FROM pg_temp._stock_kits_in i)
     AND NOT EXISTS (SELECT 1 FROM pg_temp._stock_kits_in i WHERE i.kit_code = k.kit_code AND i.component_code = k.component_code);
  GET DIAGNOSTICS v_del = ROW_COUNT;
  INSERT INTO public.stock_article_kits (kit_code, component_code, qty, source_ref, observed_at)
  SELECT i.kit_code, i.component_code, sum(i.qty), max(i.source_ref), max(i.observed_at)
  FROM pg_temp._stock_kits_in i GROUP BY 1, 2
  ON CONFLICT (kit_code, component_code) DO UPDATE SET qty = EXCLUDED.qty, source_ref = EXCLUDED.source_ref,
                                                        observed_at = EXCLUDED.observed_at;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  UPDATE public.stock_articles a SET is_set = true, updated_at = now()
   WHERE a.code IN (SELECT DISTINCT i.kit_code FROM pg_temp._stock_kits_in i) AND NOT a.is_set;
  PERFORM set_config('elyon.stock_write', 'off', true);
  SELECT count(DISTINCT i.kit_code) INTO v_kits FROM pg_temp._stock_kits_in i;

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.kits_upsert', 'stock_article_kits', NULL, 'kits',
    jsonb_build_object('kits', v_kits, 'components', v_rows, 'removed', v_del));
  RETURN jsonb_build_object('ok', true, 'kits', v_kits, 'components', v_rows, 'removed', v_del);
END
$fn$;

COMMENT ON FUNCTION public.stock_article_kits_upsert(jsonb, uuid) IS
  'Loads kits [{kit_code, components:[{code, qty}], source_ref, observed_at}]: each named kit''s components are replaced, the kit article becomes is_set. Audited stock_v2.kits_upsert. Migration 20260945000400.';

-- ── 8. recipes, exemptions, aliases ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.product_articles_set(
  p_product    uuid,
  p_lines      jsonb,
  p_valid_from timestamptz,
  p_source     text,
  p_confidence text,
  p_approve    boolean,
  p_note       text,
  p_actor      uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_from    timestamptz := coalesce(p_valid_from, '-infinity'::timestamptz);
  v_status  text := CASE WHEN coalesce(p_approve, false) THEN 'approved' ELSE 'proposed' END;
  v_name    text;
  v_lines   jsonb := coalesce(p_lines, '[]'::jsonb);
  v_bad     jsonb;
  v_before  jsonb;
  v_rej     integer := 0;
  v_closed  integer := 0;
  v_ins     integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT p.name INTO v_name FROM public.products p WHERE p.id = p_product;
  IF v_name IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'unknown_product'); END IF;
  IF jsonb_typeof(v_lines) <> 'array' OR jsonb_array_length(v_lines) > 50 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_lines');
  END IF;
  IF p_confidence IS NOT NULL AND p_confidence NOT IN ('high', 'medium', 'low') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_confidence');
  END IF;

  WITH x AS (
    SELECT e.ord, upper(btrim(coalesce(e.v ->> 'code', ''))) AS code,
           CASE WHEN jsonb_typeof(e.v -> 'qty') = 'number' THEN (e.v ->> 'qty')::numeric ELSE public.stock_v2_num(e.v ->> 'qty') END AS q,
           coalesce(nullif(e.v ->> 'role', ''), 'main') AS role
    FROM jsonb_array_elements(v_lines) WITH ORDINALITY AS e(v, ord)
  )
  SELECT jsonb_agg(jsonb_build_object('line', x.ord, 'code', x.code, 'qty', x.q, 'role', x.role) ORDER BY x.ord)
    INTO v_bad
    FROM x
   WHERE x.q IS NULL OR x.q <= 0 OR x.q > 100 OR x.q <> round(x.q, 3)
      OR x.role NOT IN ('main', 'component', 'gift')
      OR NOT EXISTS (SELECT 1 FROM public.stock_articles a WHERE a.code = x.code)
      OR (SELECT count(*) FROM x x2 WHERE x2.code = x.code) > 1;
  IF v_bad IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_lines', 'bad', v_bad); END IF;
  -- a proposal cannot sit next to an approved version of the same start (uq_product_articles_live):
  -- propose from a later valid_from, or approve directly
  IF v_status = 'proposed' AND EXISTS (SELECT 1 FROM public.product_articles a
                                        WHERE a.product_id = p_product AND a.valid_from = v_from AND a.status = 'approved') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'approved_exists', 'valid_from', v_from);
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('code', a.article_code, 'qty', a.qty, 'role', a.role, 'status', a.status,
                                               'valid_from', a.valid_from, 'valid_to', a.valid_to) ORDER BY a.valid_from, a.article_code), '[]'::jsonb)
    INTO v_before
    FROM public.product_articles a WHERE a.product_id = p_product AND a.status <> 'rejected';

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  PERFORM set_config('elyon.stock_write', 'on', true);
  -- the version at this valid_from is replaced (and, when approving, any proposal for it)
  UPDATE public.product_articles a SET status = 'rejected', note = coalesce(a.note, '') || ' [superseded]'
   WHERE a.product_id = p_product AND a.valid_from = v_from AND a.status <> 'rejected'
     AND (v_status = 'approved' OR a.status = 'proposed');
  GET DIAGNOSTICS v_rej = ROW_COUNT;
  IF v_status = 'approved' THEN
    -- an earlier approved version ends where this one starts
    UPDATE public.product_articles a SET valid_to = v_from
     WHERE a.product_id = p_product AND a.status = 'approved' AND a.valid_from < v_from
       AND (a.valid_to IS NULL OR a.valid_to > v_from);
    GET DIAGNOSTICS v_closed = ROW_COUNT;
  END IF;
  INSERT INTO public.product_articles
    (product_id, article_code, qty, role, valid_from, status, source, confidence, approved_by, approved_at, note)
  SELECT p_product, upper(btrim(e ->> 'code')),
         CASE WHEN jsonb_typeof(e -> 'qty') = 'number' THEN (e ->> 'qty')::numeric ELSE public.stock_v2_num(e ->> 'qty') END,
         coalesce(nullif(e ->> 'role', ''), 'main'), v_from, v_status, nullif(btrim(coalesce(p_source, '')), ''), p_confidence,
         CASE WHEN v_status = 'approved' THEN p_actor END, CASE WHEN v_status = 'approved' THEN now() END,
         nullif(left(btrim(coalesce(p_note, '')), 500), '')
  FROM jsonb_array_elements(v_lines) e;
  GET DIAGNOSTICS v_ins = ROW_COUNT;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'products.recipe_set', 'products', p_product::text, v_name,
    jsonb_build_object('status', v_status, 'valid_from', v_from, 'lines', v_lines, 'source', p_source,
                       'confidence', p_confidence, 'note', p_note, 'before', v_before,
                       'superseded', v_rej, 'closed', v_closed));
  RETURN jsonb_build_object('ok', true, 'product_id', p_product, 'status', v_status, 'valid_from', v_from,
                            'lines', v_ins, 'superseded', v_rej, 'closed', v_closed);
END
$fn$;

COMMENT ON FUNCTION public.product_articles_set(uuid, jsonb, timestamptz, text, text, boolean, text, uuid) IS
  'POST products/articles (owners): sets a CRM product''s recipe [{code, qty, role}] from p_valid_from (default -infinity) — proposed, or approved at once (p_approve: the earlier approved version is closed at p_valid_from). The version at the same valid_from is superseded (rejected). Only approved rows move stock / cost. Audited products.recipe_set. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.product_articles_approve(p_products uuid[], p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids    uuid[];
  v_rej    integer := 0;
  v_closed integer := 0;
  v_appr   integer := 0;
  v_prods  integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  SELECT coalesce(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(p_products) i WHERE i IS NOT NULL;
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'no_products'); END IF;
  IF cardinality(v_ids) > 2000 THEN RETURN jsonb_build_object('ok', false, 'error', 'too_many_products'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  PERFORM set_config('elyon.stock_write', 'on', true);
  -- per (product, valid_from) with a proposal: the approved version there is replaced …
  UPDATE public.product_articles a SET status = 'rejected', note = coalesce(a.note, '') || ' [replaced by approval]'
   WHERE a.status = 'approved' AND a.product_id = ANY (v_ids)
     AND EXISTS (SELECT 1 FROM public.product_articles p
                  WHERE p.product_id = a.product_id AND p.valid_from = a.valid_from AND p.status = 'proposed');
  GET DIAGNOSTICS v_rej = ROW_COUNT;
  -- … an earlier approved version ends where the proposal starts …
  UPDATE public.product_articles a SET valid_to = p.vf
    FROM (SELECT x.product_id, min(x.valid_from) AS vf FROM public.product_articles x
           WHERE x.status = 'proposed' AND x.product_id = ANY (v_ids) GROUP BY 1) p
   WHERE a.product_id = p.product_id AND a.status = 'approved' AND a.valid_from < p.vf
     AND (a.valid_to IS NULL OR a.valid_to > p.vf);
  GET DIAGNOSTICS v_closed = ROW_COUNT;
  -- … and the proposal becomes the recipe
  UPDATE public.product_articles a SET status = 'approved', approved_by = p_actor, approved_at = now()
   WHERE a.status = 'proposed' AND a.product_id = ANY (v_ids);
  GET DIAGNOSTICS v_appr = ROW_COUNT;
  PERFORM set_config('elyon.stock_write', 'off', true);
  SELECT count(DISTINCT a.product_id) INTO v_prods FROM public.product_articles a
   WHERE a.product_id = ANY (v_ids) AND a.approved_by = p_actor AND a.approved_at >= now() - interval '1 second' AND a.status = 'approved';

  PERFORM public.stock_v2_audit(p_actor, 'products.recipe_approve', 'products',
    CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1]::text END, 'recipes',
    jsonb_build_object('products', to_jsonb(v_ids), 'approved_lines', v_appr, 'replaced_lines', v_rej, 'closed_lines', v_closed));
  RETURN jsonb_build_object('ok', true, 'requested', cardinality(v_ids), 'products_approved', v_prods,
                            'approved_lines', v_appr, 'replaced_lines', v_rej, 'closed_lines', v_closed);
END
$fn$;

COMMENT ON FUNCTION public.product_articles_approve(uuid[], uuid) IS
  'POST products/articles/approve (owners): every proposed recipe line of the products becomes approved; the approved version at the same valid_from is replaced, an earlier one closed. Audited products.recipe_approve. Migration 20260945000400.';

-- p_lines NULL = remove the alias; [] = not stock; [{code, qty}] = those articles
CREATE OR REPLACE FUNCTION public.stock_article_alias_set(p_source text, p_key text, p_lines jsonb, p_approve boolean, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_key    text := public.stock_v2_alias_key(p_source, p_key);
  v_status text := CASE WHEN coalesce(p_approve, false) THEN 'approved' ELSE 'proposed' END;
  v_parsed jsonb;
  v_before jsonb;
  v_n      integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF p_source IS NULL OR p_source NOT IN ('collabbox_code', 'collabbox_name', 'web_product', 'web_sku', 'name_any') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'bad_source');
  END IF;
  IF v_key IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'key_required'); END IF;
  IF p_lines IS NOT NULL AND jsonb_typeof(p_lines) <> 'array' THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_lines'); END IF;
  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) > 0 THEN
    v_parsed := public.stock_v2_parse_lines(p_lines, 0.001, 100, 50);
    IF NOT (v_parsed ->> 'ok')::boolean THEN RETURN v_parsed; END IF;
  END IF;

  SELECT coalesce(jsonb_agg(jsonb_build_object('kind', a.kind, 'code', a.article_code, 'qty', a.qty, 'status', a.status)), '[]'::jsonb)
    INTO v_before FROM public.stock_article_aliases a WHERE a.source = p_source AND a.key = v_key;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  PERFORM set_config('elyon.stock_write', 'on', true);
  DELETE FROM public.stock_article_aliases a WHERE a.source = p_source AND a.key = v_key;
  IF p_lines IS NOT NULL AND jsonb_array_length(p_lines) = 0 THEN
    INSERT INTO public.stock_article_aliases (source, key, kind, article_code, qty, status, set_by)
    VALUES (p_source, v_key, 'not_stock', NULL, 1, v_status, p_actor);
    v_n := 1;
  ELSIF p_lines IS NOT NULL THEN
    INSERT INTO public.stock_article_aliases (source, key, kind, article_code, qty, status, set_by)
    SELECT p_source, v_key, 'article', e ->> 'code', (e ->> 'qty')::numeric, v_status, p_actor
    FROM jsonb_array_elements(v_parsed -> 'lines') e;
    GET DIAGNOSTICS v_n = ROW_COUNT;
  END IF;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'stock_v2.alias_set', 'stock_article_aliases', p_source || ':' || v_key, left(p_key, 200),
    jsonb_build_object('source', p_source, 'key', v_key, 'lines', p_lines, 'status', v_status, 'before', v_before));
  RETURN jsonb_build_object('ok', true, 'source', p_source, 'key', v_key, 'rows', v_n, 'status', v_status,
                            'removed', p_lines IS NULL);
END
$fn$;

COMMENT ON FUNCTION public.stock_article_alias_set(text, text, jsonb, boolean, uuid) IS
  'Sets (replaces) the alias of one line text / code: p_lines [{code, qty}] = those articles, [] = not stock, NULL = removed; proposed or approved (only approved aliases are used). Audited stock_v2.alias_set. Migration 20260945000400.';

CREATE OR REPLACE FUNCTION public.product_stock_exempt_set(p_products uuid[], p_exempt boolean, p_reason text, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_ids    uuid[];
  v_reason text := nullif(left(btrim(coalesce(p_reason, '')), 300), '');
  v_n      integer := 0;
BEGIN
  IF p_actor IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'actor_required'); END IF;
  IF p_exempt IS NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'exempt_required'); END IF;
  SELECT coalesce(array_agg(DISTINCT i), '{}') INTO v_ids FROM unnest(p_products) i
   WHERE i IS NOT NULL AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = i);
  IF cardinality(v_ids) = 0 THEN RETURN jsonb_build_object('ok', false, 'error', 'no_products'); END IF;
  IF p_exempt AND (v_reason IS NULL OR length(v_reason) < 3) THEN RETURN jsonb_build_object('ok', false, 'error', 'reason_required'); END IF;

  PERFORM pg_advisory_xact_lock(hashtext('public.stock_v2_apply'));
  PERFORM set_config('elyon.stock_write', 'on', true);
  IF p_exempt THEN
    INSERT INTO public.product_stock_exempt (product_id, reason, set_by, set_at)
    SELECT i, v_reason, p_actor, now() FROM unnest(v_ids) i
    ON CONFLICT (product_id) DO UPDATE SET reason = EXCLUDED.reason, set_by = EXCLUDED.set_by, set_at = EXCLUDED.set_at;
  ELSE
    DELETE FROM public.product_stock_exempt e WHERE e.product_id = ANY (v_ids);
  END IF;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  PERFORM set_config('elyon.stock_write', 'off', true);

  PERFORM public.stock_v2_audit(p_actor, 'products.stock_exempt', 'products',
    CASE WHEN cardinality(v_ids) = 1 THEN v_ids[1]::text END, CASE WHEN p_exempt THEN 'exempt' ELSE 'not exempt' END,
    jsonb_build_object('products', to_jsonb(v_ids), 'exempt', p_exempt, 'reason', v_reason, 'rows', v_n));
  RETURN jsonb_build_object('ok', true, 'exempt', p_exempt, 'products', cardinality(v_ids), 'rows', v_n);
END
$fn$;

COMMENT ON FUNCTION public.product_stock_exempt_set(uuid[], boolean, text, uuid) IS
  'Marks CRM products as never moving stock (delivery, points, flyers…) or clears it. Audited products.stock_exempt. Migration 20260945000400.';

-- ── 9. grants: service role only ────────────────────────────────────────────
DO $grants$
DECLARE f text;
BEGIN
  FOREACH f IN ARRAY ARRAY[
    'public.stock_v2_audit(uuid, text, text, text, text, jsonb)',
    'public.stock_v2_parse_lines(jsonb, numeric, numeric, integer)',
    'public.stock_v2_cost_at(text, timestamptz)',
    'public.stock_v2_config()',
    'public.stock_v2_set(boolean, jsonb, uuid)',
    'public.stock_v2_count_save(text, timestamptz, text, jsonb, text, text, boolean, text, uuid, boolean, boolean)',
    'public.stock_v2_count_approve(uuid, uuid)',
    'public.stock_v2_count_void(uuid, text, uuid)',
    'public.stock_v2_manual_move(text, text, text, timestamptz, jsonb, text, text, uuid, boolean)',
    'public.stock_v2_manual_move_void(uuid, text, uuid)',
    'public.stock_v2_parcel_override(text, text, jsonb, text, uuid)',
    'public.stock_v2_config_set(jsonb, uuid)',
    'public.stock_articles_upsert(jsonb, text, uuid, boolean)',
    'public.stock_article_kits_upsert(jsonb, uuid)',
    'public.product_articles_set(uuid, jsonb, timestamptz, text, text, boolean, text, uuid)',
    'public.product_articles_approve(uuid[], uuid)',
    'public.stock_article_alias_set(text, text, jsonb, boolean, uuid)',
    'public.product_stock_exempt_set(uuid[], boolean, text, uuid)']
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_read_only_user') THEN
    GRANT EXECUTE ON FUNCTION public.stock_v2_config() TO supabase_read_only_user;
  END IF;
END
$grants$;

NOTIFY pgrst, 'reload schema';

COMMIT;
