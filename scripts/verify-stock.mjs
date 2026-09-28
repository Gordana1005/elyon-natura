/**
 * verify-stock — READ-ONLY proof that stock on hand is exactly the last
 * physical count plus the movements after it, and that the MEX stock ledger
 * (migration 20260942000100_stock_mex_movements) moved every parcel exactly
 * once.
 *
 *   node scripts/verify-stock.mjs                       (the live state)
 *   node scripts/verify-stock.mjs --from 2026-08-20     (preview scope before the first count)
 *   node scripts/verify-stock.mjs --json
 *
 * Before the migration is applied it runs stock_mex_desired()'s body straight
 * out of the migration file (a plain read-only SELECT, the parameters
 * inlined) and reports what the ledger WOULD move from --from (default the
 * last deduction, 2026-08-20): parcels, owners, units, unmapped lines,
 * parcels with nothing to deduct. The file itself is what is proven.
 *
 * Once applied:
 *   V1  on-hand = the product's last count + every inventory_logs change after
 *       it, for every product a count covered
 *   V2  every ledger line = the sum of its movements (a deduct −, a restock +),
 *       and no movement points at a ledger line that does not hold it
 *   V3  exactly one ledger row per (parcel, owner, kind) — the UNIQUE key, and
 *       no movement without its ledger row
 *   V4  (switched on) every parcel since `from` has its deduct row per owner,
 *       every returned parcel its restock row, and no live row lacks a reason
 *       (the ledger's keys = stock_mex_desired()'s keys)
 *   V5  (switched on) nothing left to move except what a later count froze
 *       (stock_mex_pending) — WARN when the last run is under 45 minutes old
 *       (parcels registered since), FAIL when older
 *   V6  each ledger row's units_applied = Σ its lines
 *   INFO the settings, the last run, what was applied since `from`, what waits
 *       for review (unmapped lines, parcels with nothing to deduct)
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB unreachable.
 *
 * Safety: scripts/lib/repair-kit.mjs's guard — pinned to Macedonia
 * (bmfxhgznttcnnlqloqzp), refused if .env points at Bulgaria, every statement
 * sent with read_only: true (supabase_read_only_user). Writes nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, assertRemoteIsMk, bold, green, mkGuard, red, sqlRead, yellow } from './lib/repair-kit.mjs';

const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260942000100_stock_mex_movements.sql');
const DEFAULT_PREVIEW_FROM = '2026-08-20';   // the last stock deduction before the count regime
const DESIRED_COLS = 'tracking_id, kind, event_at, owner_kind, owner_ref, order_id, shop_order_id, owner_label, line_state, product_id, qty, line_name, line_kind, src';

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const n = (v) => Number(v ?? 0) || 0;
const fmt = (v) => n(v).toLocaleString('de-DE');

function args(argv) {
  const out = { json: false, from: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--from') out.from = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.from !== null && !/^\d{4}-\d{2}-\d{2}$/.test(out.from)) throw new Error('--from is YYYY-MM-DD');
  return out;
}

/** stock_mex_desired()'s body out of the migration file, parameters inlined. */
function desiredFromFile(fromIso, freeDeduct) {
  const mig = readFileSync(MIGRATION, 'utf8').replace(/\r\n/g, '\n');
  const a = mig.indexOf('AS $desired$\n');
  const b = mig.indexOf('\n$desired$;', a);
  if (a < 0 || b < 0) throw new Error('no $desired$ body in the migration');
  return mig.slice(a + 'AS $desired$\n'.length, b)
    .replace(/\bp_from\b/g, `${lit(fromIso)}::timestamptz`)
    .replace(/\bp_free_deduct\b/g, freeDeduct ? 'true' : 'false');
}

/** What the desired state holds: parcels, owners, units, review. `src` = a FROM-able relation. */
async function summarize(src) {
  const [s] = await sqlRead(`
WITH d(${DESIRED_COLS}) AS MATERIALIZED (${src}),
pp AS (
  SELECT d.tracking_id,
         CASE WHEN bool_or(d.line_state = 'test_phone') THEN 'test_phone'
              WHEN bool_or(d.line_state = 'no_owner') THEN 'no_owner'
              WHEN count(*) FILTER (WHERE d.line_state = 'stock') > 0 THEN 'deducts'
              WHEN count(*) FILTER (WHERE d.line_state = 'unmapped') > 0 THEN 'unmapped'
              ELSE 'no_lines' END AS what
  FROM d WHERE d.kind = 'deduct' GROUP BY d.tracking_id
)
SELECT
  (SELECT count(DISTINCT tracking_id) FROM d)::int AS parcels,
  (SELECT count(*) FROM pp)::int AS deduct_parcels,
  (SELECT count(DISTINCT tracking_id) FROM d WHERE kind = 'restock')::int AS restock_parcels,
  (SELECT count(*) FROM pp WHERE what = 'deducts')::int AS deducting,
  (SELECT count(*) FROM pp WHERE what = 'no_owner')::int AS no_owner,
  (SELECT count(*) FROM pp WHERE what = 'unmapped')::int AS only_unmapped,
  (SELECT count(*) FROM pp WHERE what = 'no_lines')::int AS no_lines,
  (SELECT count(*) FROM pp WHERE what = 'test_phone')::int AS test_phone,
  (SELECT coalesce(sum(qty), 0) FROM d WHERE kind = 'deduct' AND line_state = 'stock')::int AS units_out,
  (SELECT coalesce(sum(qty), 0) FROM d WHERE kind = 'restock' AND line_state = 'stock')::int AS units_in,
  (SELECT count(*) FROM d WHERE line_state = 'unmapped')::int AS unmapped_lines,
  (SELECT coalesce(sum(qty), 0) FROM d WHERE line_state = 'unmapped')::int AS unmapped_units,
  (SELECT count(*) FROM d WHERE line_state = 'not_stock')::int AS not_stock_lines,
  (SELECT coalesce(json_agg(x ORDER BY x.units DESC), '[]'::json) FROM (
     SELECT line_name AS name, src, line_kind AS why, count(*)::int AS lines, sum(qty)::int AS units
     FROM d WHERE line_state = 'unmapped' GROUP BY 1, 2, 3 ORDER BY 5 DESC LIMIT 10) x) AS top_unmapped`);
  return s;
}

const results = [];
const record = (id, status, label, detail) => results.push({ id, status, label, detail });

function print(json) {
  if (json) { console.log(JSON.stringify(results, null, 2)); return; }
  for (const r of results) {
    const tag = r.status === 'PASS' ? green('PASS') : r.status === 'FAIL' ? red('FAIL') : r.status === 'WARN' ? yellow('WARN') : bold('INFO');
    console.log(`${tag} ${r.id.padEnd(3)} ${r.label}`);
    if (r.detail !== undefined && r.detail !== null && !(Array.isArray(r.detail) && r.detail.length === 0)) {
      const text = typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail, null, 1);
      console.log(text.split('\n').map((l) => `      ${l}`).join('\n'));
    }
  }
}

function describeSummary(s) {
  return `${fmt(s.parcels)} parcels · deduct ${fmt(s.deduct_parcels)} (${fmt(s.deducting)} deduct, ${fmt(s.no_owner)} no order yet, `
    + `${fmt(s.only_unmapped)} only unmapped lines, ${fmt(s.no_lines)} no lines, ${fmt(s.test_phone)} test phone) · `
    + `returned ${fmt(s.restock_parcels)} · units −${fmt(s.units_out)} / +${fmt(s.units_in)} · `
    + `unmapped ${fmt(s.unmapped_lines)} lines (${fmt(s.unmapped_units)} units) · not stock ${fmt(s.not_stock_lines)} lines`;
}

async function main() {
  let a;
  try { a = args(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  mkGuard();
  await assertRemoteIsMk();

  const [st] = await sqlRead(`SELECT
      to_regprocedure('public.stock_mex_desired(timestamptz, boolean)') IS NOT NULL AS applied,
      (SELECT value FROM public.app_settings WHERE key = 'stock_mex_movements') AS mex,
      (SELECT value FROM public.app_settings WHERE key = 'stock_counted_at') AS counted_at`);

  // ── not applied yet: what the file would do ──────────────────────────────
  if (!st.applied) {
    const from = `${a.from ?? DEFAULT_PREVIEW_FROM}T00:00:00+02:00`;
    const t0 = Date.now();
    const s = await summarize(desiredFromFile(from, true));
    record('P0', 'INFO', `migration 20260942000100 not applied — the ledger's desired state from ${a.from ?? DEFAULT_PREVIEW_FROM}, straight out of the file (${Date.now() - t0} ms)`, describeSummary(s));
    record('P1', 'INFO', 'top unmapped lines', s.top_unmapped);
    print(a.json);
    return 0;
  }

  const mex = st.mex ?? {};
  const enabled = mex.enabled === true;
  const freeDeduct = mex.free_units !== 'skip';
  const from = mex.from ?? null;
  const [run] = await sqlRead(`SELECT r.status, r.started_at, r.finished_at, r.error, r.movements,
      extract(epoch FROM now() - (SELECT max(x.finished_at) FROM public.stock_mex_runs x WHERE x.status = 'ok'))::int AS ok_age_s
    FROM public.stock_mex_runs r ORDER BY r.started_at DESC LIMIT 1`);
  record('S0', 'INFO', `settings: enabled=${enabled} · from=${from ?? '—'} · free_units=${mex.free_units ?? 'deduct'} · counted_at=${st.counted_at ?? '—'}`,
    run ? `last run ${run.started_at} ${run.status}${run.error ? ` — ${run.error}` : ''} · ${fmt(run.movements)} movements` : 'no run yet');

  // ── V1 on-hand = last count + movements after it ─────────────────────────
  const v1 = await sqlRead(`
WITH lc AS (
  SELECT DISTINCT ON (l.product_id) l.product_id, c.counted_at, l.counted_qty
  FROM public.stock_count_lines l JOIN public.stock_counts c ON c.id = l.count_id
  ORDER BY l.product_id, c.counted_at DESC
), mv AS (
  SELECT lc.product_id, coalesce(sum(g.change_amount), 0)::int AS moved
  FROM lc LEFT JOIN public.inventory_logs g ON g.product_id = lc.product_id AND g.created_at > lc.counted_at
  GROUP BY lc.product_id
)
SELECT p.name, p.stock_quantity AS on_hand, lc.counted_qty, lc.counted_at, mv.moved, lc.counted_qty + mv.moved AS expected,
       (SELECT count(*) FROM lc)::int AS counted_products
FROM lc JOIN mv USING (product_id) JOIN public.products p ON p.id = lc.product_id
ORDER BY (p.stock_quantity <> lc.counted_qty + mv.moved) DESC, p.name`);
  const counted = v1[0]?.counted_products ?? 0;
  if (!counted) {
    record('V1', 'INFO', 'no stock count yet — nothing to prove on-hand against');
  } else {
    const bad = v1.filter((r) => n(r.on_hand) !== n(r.expected));
    record('V1', bad.length ? 'FAIL' : 'PASS', `on-hand = last count + movements after it (${fmt(counted)} counted products, ${fmt(bad.length)} off)`, bad.slice(0, 15));
  }

  // ── V2 ledger lines = their movements ────────────────────────────────────
  const v2 = await sqlRead(`
SELECT h.tracking_id, h.kind, h.owner_label, l.product_id, l.qty_applied,
       coalesce(g.logged, 0)::int AS logged
FROM public.stock_mex_ledger h
JOIN public.stock_mex_ledger_lines l ON l.ledger_id = h.id
LEFT JOIN (SELECT stock_ledger_id, product_id, sum(change_amount) AS logged
             FROM public.inventory_logs WHERE stock_ledger_id IS NOT NULL GROUP BY 1, 2) g
       ON g.stock_ledger_id = h.id AND g.product_id = l.product_id
WHERE coalesce(g.logged, 0) <> CASE WHEN h.kind = 'deduct' THEN -l.qty_applied ELSE l.qty_applied END
UNION ALL
SELECT h.tracking_id, h.kind, h.owner_label, g.product_id, NULL, g.logged::int
FROM (SELECT stock_ledger_id, product_id, sum(change_amount) AS logged
        FROM public.inventory_logs WHERE stock_ledger_id IS NOT NULL GROUP BY 1, 2) g
LEFT JOIN public.stock_mex_ledger_lines l ON l.ledger_id = g.stock_ledger_id AND l.product_id = g.product_id
LEFT JOIN public.stock_mex_ledger h ON h.id = g.stock_ledger_id
WHERE l.ledger_id IS NULL AND g.logged <> 0
LIMIT 50`);
  record('V2', v2.length ? 'FAIL' : 'PASS', 'every ledger line = the sum of its movements (deduct −, restock +)', v2.slice(0, 15));

  // ── V3 one row per key, no orphan movement ───────────────────────────────
  const [v3] = await sqlRead(`SELECT
    (SELECT count(*) FROM (SELECT 1 FROM public.stock_mex_ledger GROUP BY tracking_id, owner_kind, owner_ref, kind HAVING count(*) > 1) x)::int AS dup_keys,
    (SELECT count(*) FROM public.inventory_logs g WHERE g.movement_type IN ('mex_deduct', 'mex_restock', 'mex_reverse') AND g.stock_ledger_id IS NULL)::int AS orphans,
    (SELECT count(*) FROM public.stock_mex_ledger)::int AS rows_,
    (SELECT count(*) FROM public.inventory_logs WHERE stock_ledger_id IS NOT NULL)::int AS movements`);
  record('V3', v3.dup_keys || v3.orphans ? 'FAIL' : 'PASS',
    `one ledger row per (parcel, owner, kind): ${fmt(v3.rows_)} rows, ${fmt(v3.dup_keys)} duplicate keys · ${fmt(v3.movements)} MEX movements, ${fmt(v3.orphans)} without a ledger row`);

  // ── V6 units_applied = Σ lines ───────────────────────────────────────────
  const v6 = await sqlRead(`SELECT h.tracking_id, h.kind, h.units_applied, coalesce(sum(l.qty_applied), 0)::int AS lines
    FROM public.stock_mex_ledger h LEFT JOIN public.stock_mex_ledger_lines l ON l.ledger_id = h.id
    GROUP BY h.id HAVING h.units_applied <> coalesce(sum(l.qty_applied), 0) LIMIT 20`);
  record('V6', v6.length ? 'FAIL' : 'PASS', "each ledger row's units_applied = Σ its lines", v6);

  if (!from) {
    const pf = `${a.from ?? DEFAULT_PREVIEW_FROM}T00:00:00+02:00`;
    const s = await summarize(`SELECT * FROM public.stock_mex_desired(${lit(pf)}::timestamptz, ${freeDeduct})`);
    record('P0', 'INFO', `no count yet (stock_mex_movements.from is empty) — what the ledger would hold from ${a.from ?? DEFAULT_PREVIEW_FROM}`, describeSummary(s));
    print(a.json);
    return results.some((r) => r.status === 'FAIL') ? 1 : 0;
  }

  const desiredSrc = `SELECT * FROM public.stock_mex_desired(${lit(from)}::timestamptz, ${freeDeduct})`;
  const s = await summarize(desiredSrc);
  record('I1', 'INFO', `scope since ${from}`, describeSummary(s));
  const [ap] = await sqlRead(`SELECT count(*)::int AS movements,
      coalesce(-sum(change_amount) FILTER (WHERE movement_type = 'mex_deduct'), 0)::int AS out_,
      coalesce(sum(change_amount) FILTER (WHERE movement_type = 'mex_restock'), 0)::int AS in_,
      coalesce(sum(abs(change_amount)) FILTER (WHERE movement_type = 'mex_reverse'), 0)::int AS rev
    FROM public.inventory_logs WHERE stock_ledger_id IS NOT NULL AND created_at >= ${lit(from)}::timestamptz`);
  record('I2', 'INFO', `applied since ${from}: ${fmt(ap.movements)} movements · −${fmt(ap.out_)} out · +${fmt(ap.in_)} returned · ${fmt(ap.rev)} moved back`);
  record('I3', 'INFO', 'top unmapped lines (map them in product_aliases — the next run deducts them)', s.top_unmapped);

  if (!enabled) {
    const [p] = await sqlRead(`SELECT count(DISTINCT tracking_id)::int AS parcels,
        coalesce(sum(delta) FILTER (WHERE NOT frozen AND kind = 'deduct' AND delta > 0), 0)::int AS out_,
        coalesce(sum(delta) FILTER (WHERE NOT frozen AND kind = 'restock' AND delta > 0), 0)::int AS in_
      FROM public.stock_mex_pending(${lit(from)}::timestamptz, ${freeDeduct})`);
    record('V4', 'INFO', `switched off — switching on now would move ${fmt(p.parcels)} parcels: −${fmt(p.out_)} / +${fmt(p.in_)} units`);
    print(a.json);
    return results.some((r) => r.status === 'FAIL') ? 1 : 0;
  }

  const fresh = run && run.ok_age_s != null && run.ok_age_s < 45 * 60;
  // ── V4 every parcel since `from` has its rows — keys agree ───────────────
  const [v4] = await sqlRead(`
WITH d AS (SELECT DISTINCT tracking_id, owner_kind, owner_ref, kind FROM (${desiredSrc}) x),
l AS (SELECT h.tracking_id, h.owner_kind, h.owner_ref, h.kind FROM public.stock_mex_ledger h
       JOIN public.mex_parcels p ON p.tracking_id = h.tracking_id
      WHERE h.state <> 'released' AND (p.created_at_mex >= ${lit(from)}::timestamptz OR p.returned_at >= ${lit(from)}::timestamptz))
SELECT (SELECT count(*) FROM (SELECT * FROM d EXCEPT SELECT * FROM l) x)::int AS missing,
       (SELECT count(*) FROM (SELECT * FROM l EXCEPT SELECT * FROM d) x)::int AS extra,
       (SELECT count(*) FROM d)::int AS keys,
       (SELECT coalesce(json_agg(x), '[]'::json) FROM (SELECT * FROM (SELECT * FROM d EXCEPT SELECT * FROM l) y LIMIT 10) x) AS sample_missing,
       (SELECT coalesce(json_agg(x), '[]'::json) FROM (SELECT * FROM (SELECT * FROM l EXCEPT SELECT * FROM d) y LIMIT 10) x) AS sample_extra`);
  const v4bad = v4.missing + v4.extra;
  record('V4', v4bad === 0 ? 'PASS' : fresh ? 'WARN' : 'FAIL',
    `every parcel since from has one deduct row per owner, every returned parcel one restock row: ${fmt(v4.keys)} keys, ${fmt(v4.missing)} missing, ${fmt(v4.extra)} without a reason`
      + (v4bad && fresh ? ' (the last run is under 45 min old — parcels registered since wait for the next one)' : ''),
    v4bad ? { missing: v4.sample_missing, extra: v4.sample_extra } : null);

  // ── V5 nothing left to move but frozen rows ──────────────────────────────
  const [v5] = await sqlRead(`SELECT count(*) FILTER (WHERE NOT frozen)::int AS pending, count(*) FILTER (WHERE frozen)::int AS frozen,
      count(DISTINCT tracking_id) FILTER (WHERE NOT frozen)::int AS parcels,
      coalesce(sum(abs(delta)) FILTER (WHERE NOT frozen), 0)::int AS units
    FROM public.stock_mex_pending(${lit(from)}::timestamptz, ${freeDeduct})`);
  record('V5', v5.pending === 0 ? 'PASS' : fresh ? 'WARN' : 'FAIL',
    `nothing left to move: ${fmt(v5.pending)} pending rows (${fmt(v5.parcels)} parcels, ${fmt(v5.units)} units) · ${fmt(v5.frozen)} frozen by a later count`);

  print(a.json);
  return results.some((r) => r.status === 'FAIL') ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((e) => {
  console.error(red(`verify-stock: ${e.message}`));
  process.exit(2);
});
