/**
 * verify-stock-v2 — READ-ONLY proof that the stock v2 engine (migrations 20260945000100–0500,
 * contract docs/STOCK-V2.md) is installed, dark where it should be, and ties out.
 *
 *   node scripts/verify-stock-v2.mjs                 (full check — after the switch is on)
 *   node scripts/verify-stock-v2.mjs --preview       (before switch-on: checks the computed preview)
 *   node scripts/verify-stock-v2.mjs --day=2026-09-30 --json
 *
 *   --preview   the switch must be OFF and the ledger empty; every tie runs on stock_v2_desired()
 *   --day       the Skopje day for the day / parcel ties (default: yesterday)
 *   --json      one JSON document on stdout instead of the report
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / objects missing / DB unreachable.
 *
 *   S1  installed: every table, function and the cron job 'stock-v2-apply'; app_settings.stock_v2;
 *       'stock_v2' is an owner-only key of tg_app_settings_guard_owner_keys
 *   S2  locked down: RLS on every stock v2 table, no table grant to anon / authenticated, no function
 *       EXECUTE for PUBLIC / anon / authenticated, the guard triggers present (stock_moves append-only)
 *   S3  seeds per contract: warehouses main / wh08 / damaged / writeoff / lab (role, tracked), their
 *       keys, the route (priority 100 → main from 2026-09-22 00:00 Skopje), the three Sigma exclusions
 *   S4  the switch: --preview → off; on → every routed tracked warehouse has an approved opening
 *   S5  ledger integrity: no zero rows, only tracked warehouses, every run_id a stock_runs row; in
 *       --preview the ledger is empty
 *   S6  one first write per group: per (source_key, kind, article, warehouse, event_at) at most one
 *       non-correction row; corrections only on groups that had a first write
 *   S7  pending: after an ok run the ledger = desired (WARN while new facts wait for the next run,
 *       FAIL when the last run failed or the last ok run is older than 60 minutes)
 *   S8  parcel coverage: every MEX parcel created since the scope start has exactly one verdict;
 *       the states partition them
 *   S9  parcel moves = verdicts: Σ parcel_out of a parcel = its units_out, return_in only for MEX 7,
 *       nothing for test phones / excluded / pre-opening creations
 *   S10 test phones move nothing (report_excluded_phone8s())
 *   S11 collabBox first: an in-scope parcel with an eligible collabBox document resolves from it
 *   S12 the count rule: at every approved count the balance (count included) = counted − the
 *       packed parcels it was told about
 *   S13 Sigma: no move from an excluded (000217 / 000549 / 04↔08 / rules), vanished, not-included or
 *       pre-sigma_moves_from document; no move on an untracked warehouse
 *   S14 the day sheet ties: per article opening − out + back + in − other_out + adjust = closing, the
 *       totals = Σ articles, and closing(D) = opening(D+1)
 *   S15 on-hand ties: Σ stock_v2_on_hand(now) per warehouse = Σ moves up to now
 *   S16 the parcel day ties: parcels / units = Σ by_account = Σ by_status = Σ by_department, Σ hourly
 *       created = parcels, total_rows = parcels
 *   S17 no PII / no money leaks: parcel rows carry no receiver name or phone; p_money = false
 *       outputs carry no *_mkd key
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia
 * (bmfxhgznttcnnlqloqzp), refused if .env points at Bulgaria, every statement a single SELECT /
 * WITH sent with read_only: true. Nothing is written; stock_v2_apply() is never called.
 */
import { runSql } from './verify-insights-ties.mjs';

const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const flag = (name) => process.argv.includes(`--${name}`);
const n = (v) => Number(v ?? 0) || 0;

const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    fail(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
    skip(label) { c.lines.push({ label, want: null, got: 'skipped', ok: true, info: true }); if (c.status === 'PASS') c.status = 'SKIP'; },
  };
}
const one = async (sql) => (await runSql(sql))[0] ?? {};

const TABLES = ['stock_warehouses', 'stock_warehouse_keys', 'stock_parcel_routes', 'stock_articles', 'stock_article_kits',
  'product_articles', 'product_stock_exempt', 'stock_article_aliases', 'stock_article_costs', 'product_cost_history',
  'products_cost_legacy', 'stock_wh_counts', 'stock_wh_count_lines', 'stock_manual_moves', 'stock_manual_move_lines',
  'stock_parcel_overrides', 'stock_runs', 'stock_moves', 'stock_parcel_state', 'stock_sigma_batches', 'stock_sigma_docs',
  'stock_sigma_doc_versions', 'stock_sigma_doc_types', 'stock_sigma_rules', 'stock_sigma_balances', 'stock_sigma_drafts'];
const GUARDED = ['stock_warehouses', 'stock_warehouse_keys', 'stock_parcel_routes', 'stock_articles', 'stock_article_kits',
  'product_articles', 'product_stock_exempt', 'stock_article_aliases', 'stock_wh_counts', 'stock_wh_count_lines',
  'stock_manual_moves', 'stock_manual_move_lines', 'stock_parcel_overrides', 'stock_parcel_state'];
const FUNCTIONS = [
  'public.stock_v2_parcel_lines(timestamptz,timestamptz)', 'public.stock_v2_parcels(timestamptz,timestamptz)',
  'public.stock_v2_desired()', 'public.stock_v2_pending()', 'public.stock_v2_apply(text,boolean)',
  'public.stock_v2_reset(uuid,text)', 'public.stock_v2_set(boolean,jsonb,uuid)',
  'public.stock_v2_count_save(text,timestamptz,text,jsonb,text,text,boolean,text,uuid,boolean,boolean)',
  'public.stock_v2_count_approve(uuid,uuid)', 'public.stock_v2_count_void(uuid,text,uuid)',
  'public.stock_v2_manual_move(text,text,text,timestamptz,jsonb,text,text,uuid,boolean)',
  'public.stock_v2_manual_move_void(uuid,text,uuid)', 'public.stock_v2_parcel_override(text,text,jsonb,text,uuid)',
  'public.stock_v2_config_set(jsonb,uuid)', 'public.stock_v2_config()', 'public.stock_articles_upsert(jsonb,text,uuid,boolean)',
  'public.stock_article_kits_upsert(jsonb,uuid)',
  'public.product_articles_set(uuid,jsonb,timestamptz,text,text,boolean,text,uuid)',
  'public.product_articles_approve(uuid[],uuid)', 'public.stock_article_alias_set(text,text,jsonb,boolean,uuid)',
  'public.product_stock_exempt_set(uuid[],boolean,text,uuid)',
  'public.stock_v2_on_hand(timestamptz,text,boolean)', 'public.stock_v2_position_at(timestamptz,text,boolean)',
  'public.stock_v2_day(date,text,time,boolean,boolean)', 'public.stock_v2_article_series(text,text,date,date,boolean)',
  'public.stock_v2_parcels_day(date,jsonb,integer,integer,boolean)', 'public.stock_v2_movements(jsonb,integer,integer)',
  'public.stock_v2_reserved_now()', 'public.stock_v2_health(boolean)', 'public.stock_v2_sigma_month_check(date)'];

const sqlList = (xs) => xs.map((x) => `'${x}'`).join(', ');

async function main() {
  const json = flag('json');
  const preview = flag('preview');

  // ── S1 installed ───────────────────────────────────────────────────────────
  const inst = await one(`
    SELECT (SELECT coalesce(jsonb_agg(t ORDER BY t), '[]'::jsonb) FROM unnest(ARRAY[${sqlList(TABLES)}]) t
             WHERE to_regclass('public.' || t) IS NULL) AS missing_tables,
           (SELECT coalesce(jsonb_agg(f ORDER BY f), '[]'::jsonb) FROM unnest(ARRAY[${sqlList(FUNCTIONS)}]) f
             WHERE to_regprocedure(f) IS NULL) AS missing_functions,
           EXISTS (SELECT 1 FROM public.app_settings a WHERE a.key = 'stock_v2') AS setting,
           coalesce((SELECT p.prosrc LIKE '%''stock_v2''%' FROM pg_proc p
                      WHERE p.oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()')), false) AS owner_key,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'mex_parcels' AND column_name = 'picked_up_at') AS picked_up_at,
           (now() AT TIME ZONE 'Europe/Skopje')::date AS today`);
  const today = String(inst.today).slice(0, 10);
  const s1 = check('S1', 'installed: tables, functions, cron, setting, owner-only key');
  if (inst.missing_tables.length || inst.missing_functions.length) {
    const msg = `objects missing — apply 20260945000100…0500 first (tables: ${inst.missing_tables.join(', ') || '—'}; functions: ${inst.missing_functions.join(', ') || '—'})`;
    if (json) console.log(JSON.stringify({ ok: false, error: 'objects_missing', missing: inst }, null, 2));
    else console.error(`verify-stock-v2: ${msg}`);
    process.exit(2);
  }
  try {
    const [cj] = await runSql(`SELECT j.schedule, j.active FROM cron.job j WHERE j.jobname = 'stock-v2-apply'`);
    s1.tie('cron job stock-v2-apply', { schedule: '12,27,42,57 * * * *', active: true }, cj ? { schedule: cj.schedule, active: cj.active } : null);
  } catch (e) {
    s1.warn('cron.job not readable with the read-only role', String(e?.message ?? e).slice(0, 120));
  }
  s1.tie('app_settings.stock_v2', true, inst.setting);
  s1.tie('stock_v2 is an owner-only key', true, inst.owner_key);
  s1.tie('mex_parcels.picked_up_at (20260945000900)', true, inst.picked_up_at);

  // ── S2 locked down ─────────────────────────────────────────────────────────
  const sec = await one(`
    SELECT (SELECT coalesce(jsonb_agg(c.relname ORDER BY c.relname), '[]'::jsonb) FROM pg_class c
             WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (ARRAY[${sqlList(TABLES)}]) AND NOT c.relrowsecurity) AS no_rls,
           (SELECT coalesce(jsonb_agg(DISTINCT g.table_name || ':' || g.grantee), '[]'::jsonb) FROM information_schema.role_table_grants g
             WHERE g.table_schema = 'public' AND g.table_name = ANY (ARRAY[${sqlList(TABLES)}])
               AND g.grantee IN ('anon', 'authenticated', 'PUBLIC')) AS table_grants,
           (SELECT coalesce(jsonb_agg(DISTINCT p.oid::regprocedure::text), '[]'::jsonb) FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace
               AND (p.proname LIKE 'stock\\_v2\\_%' OR p.proname IN ('stock_articles_upsert', 'stock_article_kits_upsert',
                    'product_articles_set', 'product_articles_approve', 'stock_article_alias_set', 'product_stock_exempt_set'))
               AND (has_function_privilege('anon', p.oid, 'EXECUTE') OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))) AS fn_grants,
           (SELECT coalesce(jsonb_agg(t ORDER BY t), '[]'::jsonb) FROM unnest(ARRAY[${sqlList(GUARDED)}]) t
             WHERE NOT EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = to_regclass('public.' || t)
                                AND tg.tgname = 'trg_' || t || '_guard' AND NOT tg.tgisinternal)) AS no_guard,
           EXISTS (SELECT 1 FROM pg_trigger tg WHERE tg.tgrelid = 'public.stock_moves'::regclass AND tg.tgname = 'trg_stock_moves_guard') AS moves_guard`);
  const s2 = check('S2', 'locked down: RLS, grants, guard triggers');
  s2.tie('tables without RLS', [], sec.no_rls);
  s2.tie('table grants to anon / authenticated / PUBLIC', [], sec.table_grants);
  s2.tie('functions executable by anon / authenticated', [], sec.fn_grants);
  s2.tie('tables without the write-gate trigger', [], sec.no_guard);
  s2.tie('stock_moves append-only trigger', true, sec.moves_guard);

  // ── S3 seeds ───────────────────────────────────────────────────────────────
  const seed = await one(`
    SELECT (SELECT jsonb_object_agg(w.code, jsonb_build_object('role', w.role, 'tracked', w.tracked)) FROM public.stock_warehouses w
             WHERE w.code IN ('main', 'wh08', 'damaged', 'writeoff', 'lab')) AS wh,
           (SELECT jsonb_object_agg(k.system || ':' || k.key, w.code) FROM public.stock_warehouse_keys k
              JOIN public.stock_warehouses w ON w.id = k.warehouse_id) AS keys,
           (SELECT to_char(w.sigma_moves_from AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') FROM public.stock_warehouses w WHERE w.code = 'main') AS main_from,
           (SELECT jsonb_agg(jsonb_build_object('priority', r.priority, 'wh', w.code,
                                                'from', to_char(r.valid_from AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI'),
                                                'filters', r.match_account IS NOT NULL OR r.match_series IS NOT NULL OR r.match_shape IS NOT NULL)
                             ORDER BY r.priority, r.id)
              FROM public.stock_parcel_routes r JOIN public.stock_warehouses w ON w.id = r.warehouse_id WHERE r.active) AS routes,
           (SELECT count(*) FROM public.stock_sigma_rules s WHERE s.active AND s.action = 'exclude' AND s.match = '{"client_code":"000217"}'::jsonb) AS r217,
           (SELECT count(*) FROM public.stock_sigma_rules s WHERE s.active AND s.action = 'exclude' AND s.match = '{"client_code":"000549"}'::jsonb) AS r549,
           (SELECT count(*) FROM public.stock_sigma_rules s WHERE s.active AND s.action = 'exclude'
              AND s.match -> 'objects' @> '["Ф00001-04","Ф00001-08"]'::jsonb) AS r0408`);
  const s3 = check('S3', 'seeds per contract');
  s3.tie('warehouses', {
    damaged: { role: 'damaged', tracked: true }, lab: { role: 'lab', tracked: false }, main: { role: 'main', tracked: true },
    wh08: { role: 'review', tracked: false }, writeoff: { role: 'writeoff', tracked: false },
  }, Object.fromEntries(Object.entries(seed.wh ?? {}).sort()));
  for (const [k, v] of Object.entries({ 'sigma:Ф00001-04': 'main', 'collabbox:002': 'main', 'sigma:Ф00001-08': 'wh08',
    'collabbox:014': 'damaged', 'sigma:Ф00001-11': 'writeoff', 'sigma:Ф00002-00': 'lab' })) s3.tie(`key ${k}`, v, seed.keys?.[k] ?? null);
  s3.tie('main.sigma_moves_from', '2026-09-22 00:00', seed.main_from);
  const r100 = (seed.routes ?? []).find((r) => r.priority === 100 && !r.filters);
  s3.tie('route priority 100, no filters → main from 22.09 00:00', { wh: 'main', from: '2026-09-22 00:00' }, r100 ? { wh: r100.wh, from: r100.from } : null);
  s3.tie('Sigma exclusion 000217 (МЕКС ПОШТА)', 1, n(seed.r217));
  s3.tie('Sigma exclusion 000549 (АД Астра)', 1, n(seed.r549));
  s3.tie('Sigma exclusion 04↔08', 1, n(seed.r0408));

  // ── S4 the switch ──────────────────────────────────────────────────────────
  const sw = await one(`
    SELECT public.stock_v2_enabled() AS enabled,
           (SELECT count(*) FROM public.stock_moves) AS moves,
           (SELECT coalesce(jsonb_agg(w.code ORDER BY w.code), '[]'::jsonb) FROM public.stock_warehouses w
             WHERE w.tracked
               AND w.id IN (SELECT r.warehouse_id FROM public.stock_parcel_routes r WHERE r.active
                            UNION SELECT r.return_warehouse_id FROM public.stock_parcel_routes r WHERE r.active)
               AND NOT EXISTS (SELECT 1 FROM public.stock_wh_counts c
                                WHERE c.warehouse_id = w.id AND c.kind = 'opening' AND c.status = 'approved')) AS no_opening,
           (SELECT jsonb_build_object('at', r.finished_at, 'status', r.status, 'age_min', round(extract(epoch FROM now() - coalesce(r.finished_at, r.started_at)) / 60))
              FROM public.stock_runs r WHERE NOT r.dry ORDER BY r.started_at DESC LIMIT 1) AS last_run,
           (SELECT round(extract(epoch FROM now() - max(r.finished_at)) / 60) FROM public.stock_runs r WHERE r.status = 'ok' AND NOT r.dry) AS ok_age_min`);
  const s4 = check('S4', 'the switch');
  if (preview) {
    s4.tie('stock_v2.enabled (preview mode expects off)', false, sw.enabled);
  } else {
    s4.info('stock_v2.enabled', sw.enabled);
    if (sw.enabled) s4.tie('routed warehouses without an approved opening', [], sw.no_opening);
    else s4.warn('switch is off — run with --preview before switch-on', 'off');
  }
  s4.info('openings missing for', sw.no_opening);
  const ledgerMode = !preview && sw.enabled;

  // ── S5 ledger integrity ────────────────────────────────────────────────────
  const led = await one(`
    SELECT (SELECT count(*) FROM public.stock_moves) AS rows,
           (SELECT count(*) FROM public.stock_moves m WHERE m.qty = 0) AS zero_rows,
           (SELECT count(*) FROM public.stock_moves m JOIN public.stock_warehouses w ON w.id = m.warehouse_id WHERE NOT w.tracked) AS untracked,
           (SELECT count(*) FROM public.stock_moves m WHERE m.run_id IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM public.stock_runs r WHERE r.id = m.run_id)) AS orphan_run`);
  const s5 = check('S5', 'ledger integrity');
  if (preview) s5.tie('ledger rows (preview: nothing written yet)', 0, n(led.rows));
  else s5.info('ledger rows', n(led.rows));
  s5.tie('zero-quantity rows', 0, n(led.zero_rows));
  s5.tie('rows on an untracked warehouse', 0, n(led.untracked));
  s5.tie('rows whose run is missing', 0, n(led.orphan_run));

  // ── S6 one first write per group ───────────────────────────────────────────
  const grp = await one(`
    WITH g AS (
      SELECT m.source_key, m.kind, m.article_code, m.warehouse_id, m.event_at,
             count(*) FILTER (WHERE NOT m.correction) AS firsts, count(*) FILTER (WHERE m.correction) AS corr
      FROM public.stock_moves m GROUP BY 1, 2, 3, 4, 5)
    SELECT count(*) AS groups, count(*) FILTER (WHERE g.firsts > 1) AS multi_first,
           count(*) FILTER (WHERE g.firsts = 0 AND g.corr > 0) AS corr_without_first,
           coalesce(sum(g.corr), 0) AS corrections
    FROM g`);
  const s6 = check('S6', 'one first write per ledger group');
  s6.tie('groups with more than one non-correction row', 0, n(grp.multi_first));
  s6.info('groups / correction rows', `${n(grp.groups)} / ${n(grp.corrections)}`);
  if (n(grp.corr_without_first)) s6.info('correction-only groups (a negation of a reset, or a late group)', n(grp.corr_without_first));

  // ── S7 pending ─────────────────────────────────────────────────────────────
  const pend = await one(`
    SELECT count(*) AS groups, coalesce(sum(abs(p.delta)), 0) AS units,
           count(*) FILTER (WHERE p.correction) AS corrections
    FROM public.stock_v2_pending() p`);
  const s7 = check('S7', 'pending = desired − applied');
  if (preview) {
    s7.info('groups / units a first run would write', `${n(pend.groups)} / ${n(pend.units)}`);
  } else if (ledgerMode) {
    if (sw.last_run?.status === 'failed') s7.fail('last run', sw.last_run);
    if (sw.ok_age_min == null || n(sw.ok_age_min) > 60) s7.fail('last ok run older than 60 minutes', sw.ok_age_min);
    if (n(pend.groups) > 0) s7.warn('groups waiting for the next run (new facts since the last run)', `${n(pend.groups)} groups / ${n(pend.units)} units`);
  } else s7.skip('switch is off');

  // ── S8 parcel coverage · S9 moves = verdicts · S10 test phones · S11 collabBox first ─
  const src = ledgerMode ? 'ledger' : 'desired';
  const moveSrc = ledgerMode
    ? `(SELECT m.tracking_id, m.kind, m.qty, m.source FROM public.stock_moves m)`
    : `(SELECT d.tracking_id, d.kind, d.qty, d.source FROM public.stock_v2_desired() d)`;
  const pc = await one(`
    WITH p AS MATERIALIZED (SELECT * FROM public.stock_v2_parcels(NULL, NULL)),
    mv AS MATERIALIZED (SELECT x.tracking_id, x.kind, sum(x.qty) AS q FROM ${moveSrc} x
                         WHERE x.tracking_id IS NOT NULL AND x.kind IN ('parcel_out', 'return_in') GROUP BY 1, 2),
    sc AS (SELECT public.stock_v2_scope_from() AS f),
    mp AS (SELECT p2.tracking_id FROM public.mex_parcels p2, sc WHERE p2.created_at_mex >= sc.f),
    tp AS (SELECT public.report_excluded_phone8s() AS a),
    cb AS (SELECT d.doc_number FROM public.collabbox_documents d
            WHERE d.doc_number IN (SELECT p.tracking_id FROM p) AND NOT d.is_storno AND d.lines_complete
              AND jsonb_typeof(d.payload -> 'lines') = 'array'
              AND EXISTS (SELECT 1 FROM jsonb_array_elements(d.payload -> 'lines') e
                           WHERE e ->> 'role' = 'goods' AND public.stock_v2_num(e ->> 'qty') > 0))
    SELECT (SELECT count(*) FROM mp) AS created,
           (SELECT count(*) FROM p WHERE p.tracking_id IN (SELECT mp.tracking_id FROM mp)) AS with_verdict,
           (SELECT count(*) - count(DISTINCT p.tracking_id) FROM p) AS dup_verdicts,
           (SELECT jsonb_object_agg(s.state, s.n) FROM (SELECT p.state, count(*) AS n FROM p GROUP BY 1) s) AS states,
           (SELECT count(*) FROM p LEFT JOIN mv ON mv.tracking_id = p.tracking_id AND mv.kind = 'parcel_out'
             WHERE round(coalesce(-mv.q, 0), 3) <> round(p.units_out, 3)) AS out_mismatch,
           (SELECT count(*) FROM mv JOIN public.mex_parcels x ON x.tracking_id = mv.tracking_id
             WHERE mv.kind = 'return_in' AND mv.q <> 0 AND x.status_id <> 7) AS ret_not7,
           (SELECT count(*) FROM p JOIN mv ON mv.tracking_id = p.tracking_id AND mv.kind = 'parcel_out' AND mv.q <> 0
             WHERE p.state IN ('test_phone', 'excluded', 'pre_opening')) AS out_forbidden,
           (SELECT count(*) FROM mv JOIN public.mex_parcels x ON x.tracking_id = mv.tracking_id, tp
             WHERE mv.q <> 0 AND x.phone8 = ANY (tp.a)) AS test_moves,
           (SELECT count(*) FROM p WHERE p.tracking_id IN (SELECT cb.doc_number FROM cb)
               AND p.state NOT IN ('test_phone', 'excluded') AND coalesce(p.lines_source, '') NOT IN ('collabbox', 'override')) AS cb_not_first,
           (SELECT count(*) FROM cb) AS cb_docs`);
  const s8 = check('S8', 'parcel coverage');
  s8.tie('MEX parcels created since the scope start with a verdict', n(pc.created), n(pc.with_verdict));
  s8.tie('parcels with more than one verdict', 0, n(pc.dup_verdicts));
  s8.info('states', pc.states);
  const s9 = check('S9', `parcel moves = verdicts (${src})`);
  s9.tie('parcels whose Σ parcel_out ≠ units_out', 0, n(pc.out_mismatch));
  s9.tie('return_in on a parcel not at MEX 7', 0, n(pc.ret_not7));
  s9.tie('parcel_out on a test / excluded / pre-opening parcel', 0, n(pc.out_forbidden));
  const s10 = check('S10', 'test phones move nothing');
  s10.tie('moves of test-phone parcels', 0, n(pc.test_moves));
  const s11 = check('S11', 'collabBox document first');
  s11.tie('parcels with an eligible collabBox document resolved from another source', 0, n(pc.cb_not_first));
  s11.info('eligible collabBox documents in scope', n(pc.cb_docs));

  // ── S12 the count rule ─────────────────────────────────────────────────────
  const counts = await runSql(`
    SELECT c.id, w.code AS wh, c.counted_at, c.packed_counted, l.article_code, l.counted_qty
    FROM public.stock_wh_counts c
    JOIN public.stock_wh_count_lines l ON l.count_id = c.id
    JOIN public.stock_warehouses w ON w.id = c.warehouse_id AND w.tracked
    WHERE c.status = 'approved'
    ORDER BY c.counted_at DESC, l.article_code
    LIMIT 400`);
  const s12 = check('S12', 'the count rule');
  if (!counts.length) s12.skip('no approved count yet');
  else {
    const byCount = new Map();
    for (const r of counts) { const k = `${r.id}|${r.wh}|${r.counted_at}|${r.packed_counted}`; if (!byCount.has(k)) byCount.set(k, []); byCount.get(k).push(r); }
    let bad = 0; let checked = 0;
    for (const [k, lines] of [...byCount].slice(0, 8)) {
      const [, wh, at, packed] = k.split('|');
      const pos = await runSql(`SELECT x.article_code, x.on_hand, x.to_pack FROM public.stock_v2_position_at('${at}'::timestamptz, '${wh}', ${ledgerMode ? 'false' : 'true'}) x`);
      const m = new Map(pos.map((p) => [p.article_code, p]));
      for (const l of lines) {
        checked++;
        const p = m.get(l.article_code);
        const want = n(l.counted_qty) - (packed === 'true' ? n(p?.to_pack) : 0);
        if (Math.abs(n(p?.on_hand) - want) > 0.0005) {
          bad++;
          if (bad <= 5) s12.fail(`${wh} ${l.article_code} at ${at}`, { counted: n(l.counted_qty), balance: n(p?.on_hand), want });
        }
      }
    }
    s12.info('count lines checked', checked);
    if (!bad) s12.tie('balances that differ from the count', 0, 0);
  }

  // ── S13 Sigma ──────────────────────────────────────────────────────────────
  const sg = await one(`
    WITH sm AS MATERIALIZED (SELECT x.sigma_doc, x.warehouse_id, x.event_at
                              FROM ${ledgerMode ? 'public.stock_moves' : 'public.stock_v2_desired()'} x
                              WHERE x.source = 'sigma'
                              GROUP BY 1, 2, 3 ${ledgerMode ? 'HAVING sum(x.qty) <> 0' : ''})
    SELECT (SELECT count(*) FROM public.stock_sigma_docs) AS staged,
           (SELECT count(DISTINCT sm.sigma_doc) FROM sm) AS moving_docs,
           (SELECT count(DISTINCT sm.sigma_doc) FROM sm JOIN public.stock_sigma_docs d ON d.doc_key = sm.sigma_doc
             WHERE d.vanished_at IS NOT NULL OR d.excluded_reason IS NOT NULL
                OR d.client_code IN ('000217', '000549')
                OR public.stock_v2_sigma_excluded(d.doc_key, d.doc_type, d.client_code, d.company_from, d.object_from, d.company_to, d.object_to)
                OR NOT EXISTS (SELECT 1 FROM public.stock_sigma_doc_types t WHERE t.doc_type = d.doc_type AND t.include)) AS forbidden_docs,
           (SELECT count(*) FROM sm JOIN public.stock_warehouses w ON w.id = sm.warehouse_id
             WHERE NOT w.tracked OR w.sigma_moves_from IS NULL OR sm.event_at < w.sigma_moves_from) AS bad_side`);
  const s13 = check('S13', 'Sigma moves only from allowed documents');
  s13.info('staged documents / documents that move stock', `${n(sg.staged)} / ${n(sg.moving_docs)}`);
  s13.tie('moving documents that are excluded / vanished / not included', 0, n(sg.forbidden_docs));
  s13.tie('Sigma moves on an untracked side or before sigma_moves_from', 0, n(sg.bad_side));

  // ── S14 the day sheet ties · S16 the parcel day · S17 leaks ─────────────────
  const day = arg('day') ?? (() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); })();
  const next = (() => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  const pv = ledgerMode ? 'false' : 'true';
  const dd = await one(`SELECT public.stock_v2_day('${day}'::date, 'main', NULL, false, ${pv}) AS a,
                               public.stock_v2_day('${next}'::date, 'main', NULL, false, ${pv}) AS b`);
  const s14 = check('S14', `the day sheet ties (${day}, ${src})`);
  const A = dd.a; const B = dd.b;
  let rowBad = 0;
  const sum = (k) => Math.round((A.articles ?? []).reduce((s, x) => s + n(x[k]), 0) * 1000) / 1000;
  for (const x of A.articles ?? []) {
    const calc = n(x.opening) - n(x.out) + n(x.back) + n(x.in) - n(x.other_out) + n(x.adjust);
    if (Math.abs(calc - n(x.closing)) > 0.0005) { rowBad++; if (rowBad <= 3) s14.fail(`article ${x.code}`, { calc, closing: x.closing }); }
  }
  s14.tie('articles whose opening − out + back + in − other_out + adjust ≠ closing', 0, rowBad);
  for (const k of ['opening', 'out', 'back', 'in', 'other_out', 'adjust', 'closing', 'to_pack', 'with_courier'])
    s14.tie(`totals.${k} = Σ articles`, Math.round(n(A.totals?.[k]) * 1000) / 1000, sum(k));
  if (next <= today) {
    const close = new Map((A.articles ?? []).map((x) => [x.code, n(x.closing)]));
    let carry = 0;
    for (const x of B.articles ?? []) if (Math.abs(n(x.opening) - (close.get(x.code) ?? 0)) > 0.0005) carry++;
    for (const [code, c] of close) if (c !== 0 && !(B.articles ?? []).some((x) => x.code === code)) carry++;
    s14.tie(`closing(${day}) = opening(${next})`, 0, carry);
  }
  const keysOf = (o, acc = new Set()) => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { acc.add(k); keysOf(v, acc); } return acc; };
  const s17 = check('S17', 'no PII / money leaks');
  s17.tie('day sheet without money: *_mkd keys', [], [...keysOf(A)].filter((k) => /_mkd$/.test(k)));

  const pd = (await one(`SELECT public.stock_v2_parcels_day('${day}'::date, '{}'::jsonb, 1000, 0, false) AS j`)).j;
  const s16 = check('S16', `the parcel day ties (${day})`);
  const t = pd.totals ?? {};
  const sumOf = (arr, k) => Math.round((arr ?? []).reduce((s, x) => s + n(x[k]), 0) * 1000) / 1000;
  for (const b of ['by_account', 'by_status', 'by_department']) {
    s16.tie(`${b}: Σ parcels = totals.parcels`, n(t.parcels), sumOf(pd[b], 'parcels'));
    s16.tie(`${b}: Σ units = totals.units`, Math.round(n(t.units) * 1000) / 1000, sumOf(pd[b], 'units'));
  }
  s16.tie('Σ hourly created = totals.parcels', n(t.parcels), sumOf(pd.hourly, 'created'));
  s16.tie('total_rows = totals.parcels', n(t.parcels), n(pd.total_rows));
  s16.tie('hourly has 24 hours', 24, (pd.hourly ?? []).length);
  const pk = [...keysOf(pd)];
  s17.tie('parcel rows: receiver name / phone keys', [], pk.filter((k) => /receiver_name|phone|receiver_phone/.test(k)));
  s17.tie('parcel day without money: *_mkd keys', [], pk.filter((k) => /_mkd$/.test(k)));

  // ── S15 on-hand ties ───────────────────────────────────────────────────────
  const oh = await one(`
    SELECT (SELECT coalesce(jsonb_object_agg(z.warehouse_code, z.q), '{}'::jsonb)
              FROM (SELECT o.warehouse_code, round(sum(o.qty), 3) AS q FROM public.stock_v2_on_hand(now(), NULL, ${pv}) o GROUP BY 1) z) AS fn,
           (SELECT coalesce(jsonb_object_agg(z.code, z.q), '{}'::jsonb)
              FROM (SELECT w.code, round(sum(x.qty), 3) AS q
                      FROM ${ledgerMode ? 'public.stock_moves' : 'public.stock_v2_desired()'} x
                      JOIN public.stock_warehouses w ON w.id = x.warehouse_id
                     WHERE x.event_at <= now() GROUP BY 1 HAVING round(sum(x.qty), 3) <> 0) z) AS raw`);
  const s15 = check('S15', `on-hand ties (${src})`);
  for (const wh of new Set([...Object.keys(oh.fn ?? {}), ...Object.keys(oh.raw ?? {})]))
    s15.tie(`Σ on-hand ${wh}`, n(oh.raw?.[wh]), n(oh.fn?.[wh]));
  if (!Object.keys(oh.fn ?? {}).length && !Object.keys(oh.raw ?? {}).length) s15.info('no stock yet', 0);

  // ── report ─────────────────────────────────────────────────────────────────
  const failed = results.filter((r) => r.status === 'FAIL').length;
  if (json) {
    console.log(JSON.stringify({ ok: failed === 0, mode: preview ? 'preview' : 'ledger', day, results }, null, 2));
  } else {
    console.log(`verify-stock-v2 — ${preview ? 'PREVIEW (before switch-on)' : ledgerMode ? 'LEDGER' : 'switch OFF'} · day ${day}\n`);
    for (const r of results) {
      console.log(`${r.status.padEnd(4)} ${r.id.padEnd(4)} ${r.title}`);
      for (const l of r.lines) {
        const mark = l.info ? '   ·' : l.ok ? '   ✓' : l.warn ? '   !' : '   ✗';
        const detail = l.want === null ? JSON.stringify(l.got) : l.ok ? JSON.stringify(l.got) : `want ${JSON.stringify(l.want)} got ${JSON.stringify(l.got)}`;
        console.log(`${mark} ${l.label}: ${detail}`);
      }
    }
    console.log(`\n${failed ? `${failed} check(s) FAILED` : 'all checks passed'}`);
  }
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`verify-stock-v2: ${e?.message ?? e}`);
  process.exit(2);
});
