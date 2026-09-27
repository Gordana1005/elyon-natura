#!/usr/bin/env node
/**
 * Backfill orders.sale_source / sale_source_detail (migration 20260935000000).
 *
 *   node scripts/backfill-sale-source.mjs                        # DRY RUN (default): the matrix
 *   node scripts/backfill-sale-source.mjs --apply                # fill every NULL row
 *   node scripts/backfill-sale-source.mjs --apply --limit 500    # smoke test
 *   options: --chunk <n> (default 5000, max 10000) · --pause-ms <n> (default 250)
 *
 * Owner rule (Mile, 2026-09-27): the SOURCE is how the order ARRIVED — by intake
 * path, never by "the first status was pending". The classifier is the SQL
 * function public.classify_sale_source(); this script only ever calls it, so
 * the backfill and the live insert trigger cannot disagree. Rules and the
 * reasoning behind the ElyonCRM detail order are documented in the migration.
 *
 * ── Dry run ──────────────────────────────────────────────────────────────────
 * Read-only (the Management API's read-only role). Prints, and writes to
 * exports/attribution/sale-source-matrix-<ts>.csv (counts only, no PII):
 *   source_type × external_source × duplicate? → (sale_source, detail)
 *   with order count, € total, orders in a sale status, rows still to fill,
 *   and "drift" (rows already filled — by the insert trigger — whose stored
 *   value differs from what the classifier says now; reported, never changed).
 * It works BEFORE the migration is applied: the matrix is then computed with
 * CLASSIFY_TWIN below, a SQL copy of the function. Once the function exists
 * the script computes both and refuses to --apply if they disagree anywhere,
 * so the matrix the owner reviewed is the one that gets written.
 *
 * ── Apply ────────────────────────────────────────────────────────────────────
 * Fills ONLY rows whose sale_source is NULL (the column is write-once; rows the
 * insert trigger already classified are left alone). Two passes:
 *   A. originals — classify_sale_source(own columns), keyset chunks by id;
 *   B. duplicates (orders.duplicated_from) — inherit the ORIGINAL's stored
 *      source, repeated until chains settle; a duplicate whose original can
 *      never be classified falls back to its own columns (reported).
 * Each chunk is ONE implicit transaction (no explicit BEGIN — an error then
 * rolls the chunk back and leaves the API connection clean; the pattern of
 * scripts/lib/repair-kit.mjs) with SET LOCAL session_replication_role =
 * replica, so no trigger fires: in particular trg_orders_updated_at does not
 * bump updated_at, which GET /call-agains reports as last_call_at (the pattern
 * of scripts/backfill-cpa-attribution.mjs). Only the two new columns change;
 * status is untouched, so no status/segment/notification trigger has anything
 * to do anyway. Idempotent: a second run finds nothing to fill.
 * Run it in the quiet window (after 20:55 Skopje) — ~105k rows, 21 chunks.
 *
 * 🛑 MACEDONIA ONLY. The project ref is hard-coded; config.toml must agree and
 * neither config.toml nor .env may mention the live Bulgarian ref. The token
 * in .env can write to Bulgaria too — nothing but these guards stops it. The
 * token is never printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MK_REF = 'bmfxhgznttcnnlqloqzp';
const BG_REF = 'sxymaloycddnoxudxaqp'; // live Bulgaria — never a target, never touched
const EXPORT_DIR = join(ROOT, 'exports', 'attribution');
const CLASSIFY_SIG = 'public.classify_sale_source(text,text,text,uuid,numeric,text)';

// ── The classifier's SQL twin (preview only — apply always calls the function) ─
// KEEP IN STEP with public.classify_sale_source() / elyon_crm_sale_detail() /
// is_synthetic_product_name() in supabase/migrations/20260935000000_sale_source.sql.
// The dry run proves they agree on every live row before an apply is allowed.
const JS_WS = '[\\u0009-\\u000d\\u0020\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]';
const trimSql = (col) => `regexp_replace(coalesce(${col}, ''), '^${JS_WS}+|${JS_WS}+$', '', 'g')`;
const syntheticSql = (col) =>
  `(${trimSql(col)} = '' OR ${trimSql(col)} = chr(8212) OR ${trimSql(col)} ~* '^(Cancelled|Trashed|No prior product on file)')`;
export const CLASSIFY_TWIN = (st, es, ext, pl, price, name) => `(CASE
    WHEN ${st} = 'monadon_legacy' THEN ARRAY['legacy', 'monadon_legacy']
    WHEN ${st} = 'altercpa' OR ${es} = 'altercpa'
      THEN ARRAY['altercpa', CASE WHEN ${st} = 'altercpa' THEN 'bridge' ELSE 'history' END]
    WHEN ${st} = 'affiliate' THEN ARRAY['affiliate', 'partner']
    WHEN ${st} IN ('opencart', 'opencart_abandoned', 'inbound_lead') THEN ARRAY['web', ${st}]
    WHEN ${es} ILIKE 'naturatherapy%' THEN ARRAY['web', lower(${es})]
    WHEN ${es} = 'collabbox' THEN ARRAY['collabbox',
      CASE split_part(coalesce(${ext}, ''), '-', 2)
        WHEN '9102' THEN 'teleshop' WHEN '9100' THEN 'teleshop' WHEN '9108' THEN 'social'
        WHEN '9103' THEN 'leads_out' WHEN '9110' THEN 'leads' WHEN '' THEN 'unknown'
        ELSE split_part(${ext}, '-', 2) END]
    WHEN ${st} IN ('manual', 'prediction_lead') THEN ARRAY['elyon_crm',
      CASE WHEN coalesce(${price}, 0) <= 0 OR ${syntheticSql(name)} THEN 'disposition'
           WHEN ${pl} IS NOT NULL THEN 'prediction_list' ELSE 'direct' END]
    ELSE ARRAY['legacy', coalesce(nullif(${st}, ''), 'unknown')]
  END)`;
const CLASSIFY_FN = (st, es, ext, pl, price, name) =>
  `public.classify_sale_source(${st}, ${es}, ${ext}, ${pl}, ${price}, ${name})`;

// ── console ──────────────────────────────────────────────────────────────────
const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint(31); const green = paint(32); const yellow = paint(33); const cyan = paint(36); const bold = paint(1);
const num = (n) => Number(n ?? 0).toLocaleString('de-DE');
const eur = (n) => Number(n ?? 0).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

// ── Guard + Management API (used by the CLI only; tests inject their own sql) ─
export function mkApi() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (ref !== MK_REF) refuse(`supabase/config.toml project_id = "${ref}", expected "${MK_REF}" — refusing.`);
  if (toml.includes(BG_REF)) refuse('supabase/config.toml mentions the LIVE BULGARIAN project — refusing.');
  let envText = '';
  try { envText = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* .env optional when exported */ }
  if (envText.includes(BG_REF)) refuse('.env mentions the LIVE BULGARIAN project — refusing.');
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    const v = process.env[k] || env[k];
    if (v && v.includes(BG_REF)) refuse(`${k} points at LIVE BULGARIA — refusing.`);
    if (v && !v.includes(MK_REF)) refuse(`${k} does not point at ${MK_REF} — refusing.`);
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
  if (!token) refuse('SUPABASE_ACCESS_TOKEN missing (set it in .env).');

  // Returns the LAST non-empty result set of a multi-statement query. Reads run
  // as the read-only role and are retried on gateway errors; a write is never
  // retried blindly (it may have committed) — the caller re-plans instead.
  async function sql(query, { readOnly = false } = {}) {
    const attempts = readOnly ? 4 : 1;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
        });
        const text = await res.text();
        if (!res.ok) {
          const err = new Error(`Management API ${res.status}: ${text.slice(0, 1500)}`);
          err.status = res.status;
          throw err;
        }
        if (!text) return [];
        const json = JSON.parse(text);
        return Array.isArray(json) ? json : [];
      } catch (e) {
        lastErr = e;
        const transient = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
        if (i < attempts && transient) { await new Promise((r) => setTimeout(r, 1500 * i)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }
  return { sql, sqlRead: (q) => sql(q, { readOnly: true }) };
}

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { apply: false, limit: 0, chunk: 5000, pauseMs: 250 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => { const v = Number(argv[++i]); if (!Number.isFinite(v) || v < 0) refuse(`${k} needs a number`); return v; };
    if (k === '--apply') a.apply = true;
    else if (k === '--limit') a.limit = Math.floor(val());
    else if (k === '--chunk') a.chunk = Math.min(10000, Math.max(100, Math.floor(val())));
    else if (k === '--pause-ms') a.pauseMs = Math.floor(val());
    else if (k === '--help' || k === '-h') a.help = true;
    else refuse(`unknown argument ${k}`);
  }
  return a;
}

// ── the matrix ───────────────────────────────────────────────────────────────
// A duplicate is classified as its original: the original's STORED source when
// it has one (what the insert trigger and pass B do), else the original's own
// columns. One level deep — chains are counted and resolved by pass B.
function matrixSql({ hasCol, hasFn }) {
  const eff = (f) => `CASE WHEN p.id IS NOT NULL THEN p.${f} ELSE o.${f} END`;
  const args = [eff('source_type'), eff('external_source'), eff('external_order_id'),
    eff('prediction_list_id'), eff('price'), eff('product_name')];
  const stored = hasCol
    ? `CASE WHEN p.id IS NOT NULL AND p.sale_source IS NOT NULL THEN ARRAY[p.sale_source, p.sale_source_detail] END`
    : 'NULL::text[]';
  return `
WITH c AS (
  SELECT o.source_type AS st0, o.external_source AS es0,
         (o.duplicated_from IS NOT NULL) AS dup,
         (p.duplicated_from IS NOT NULL) AS chain,
         o.price, o.status::text AS status,
         ${hasCol ? 'o.sale_source AS cur_src, o.sale_source_detail AS cur_det' : 'NULL::text AS cur_src, NULL::text AS cur_det'},
         coalesce(${stored}, ${CLASSIFY_TWIN(...args)}) AS twin,
         ${hasFn ? `coalesce(${stored}, ${CLASSIFY_FN(...args)})` : 'NULL::text[]'} AS fn
    FROM public.orders o
    LEFT JOIN public.orders p ON p.id = o.duplicated_from
), e AS (
  -- the function when it exists, else the twin (subscripts need a plain column)
  SELECT c.*, coalesce(c.fn, c.twin) AS cls FROM c
)
SELECT coalesce(st0, '-') AS source_type, coalesce(es0, '-') AS external_source, dup,
       cls[1] AS sale_source, cls[2] AS detail,
       count(*)::int AS n,
       round(coalesce(sum(price), 0)::numeric, 2)::text AS eur,
       count(*) FILTER (WHERE status IN ('confirmed','shipped','delivered','paid','returned'))::int AS in_sale_status,
       count(*) FILTER (WHERE cur_src IS NULL)::int AS to_fill,
       count(*) FILTER (WHERE cur_src IS NOT NULL
                          AND (cur_src, cur_det) IS DISTINCT FROM (cls[1], cls[2]))::int AS drift,
       count(*) FILTER (WHERE fn IS NOT NULL AND fn IS DISTINCT FROM twin)::int AS twin_mismatch,
       count(*) FILTER (WHERE chain)::int AS chains
  FROM e
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY 1, 2, 3, 4, 5;`;
}

function printMatrix(rows, log) {
  const head = ['source_type', 'external_source', 'dup', 'sale_source', 'detail', 'orders', '€', 'in sale status', 'to fill', 'drift'];
  const body = rows.map((r) => [r.source_type, r.external_source, r.dup ? 'dup' : '', r.sale_source, r.detail,
    num(r.n), eur(r.eur), num(r.in_sale_status), num(r.to_fill), r.drift ? yellow(num(r.drift)) : '0']);
  const w = head.map((h, i) => Math.max(String(h).length, ...body.map((b) => String(b[i]).replace(/\x1b\[\d+m/g, '').length)));
  const line = (cells) => cells.map((c, i) => {
    const s = String(c); const pad = w[i] - s.replace(/\x1b\[\d+m/g, '').length;
    return i >= 5 ? ' '.repeat(pad) + s : s + ' '.repeat(pad);
  }).join('  ');
  log('  ' + bold(line(head)));
  for (const b of body) log('  ' + line(b));
  const tot = rows.reduce((t, r) => ({ n: t.n + r.n, fill: t.fill + r.to_fill, eur: t.eur + Number(r.eur) }), { n: 0, fill: 0, eur: 0 });
  log(`  ${bold('total')} ${num(tot.n)} orders · € ${eur(tot.eur)} · to fill ${num(tot.fill)}`);
  // By source — the view the owner reviews.
  const bySrc = new Map();
  for (const r of rows) {
    const k = `${r.sale_source} / ${r.detail}`;
    const e = bySrc.get(k) || { n: 0, eur: 0, sale: 0 };
    e.n += r.n; e.eur += Number(r.eur); e.sale += r.in_sale_status;
    bySrc.set(k, e);
  }
  log(bold('\n  sale_source / detail                 orders          €   in sale status'));
  for (const [k, e] of [...bySrc].sort((a, b) => b[1].n - a[1].n)) {
    log(`  ${k.padEnd(34)} ${num(e.n).padStart(8)} ${eur(e.eur).padStart(14)} ${num(e.sale).padStart(10)}`);
  }
}

function writeCsv(rows, stamp, dir = EXPORT_DIR) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `sale-source-matrix-${stamp}.csv`);
  const cols = ['source_type', 'external_source', 'dup', 'sale_source', 'detail', 'n', 'eur', 'in_sale_status', 'to_fill', 'drift'];
  const esc = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  writeFileSync(file, '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n');
  return file;
}

// ── apply ────────────────────────────────────────────────────────────────────
const CHUNK_PRELUDE = `
SET LOCAL session_replication_role = replica;
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '10s';`;

/** Pass A chunk: the next `n` unclassified originals after `after` (keyset on id). */
const passASql = (after, n) => `${CHUNK_PRELUDE}
WITH todo AS (
  SELECT o.id FROM public.orders o
   WHERE o.duplicated_from IS NULL
     AND o.sale_source IS NULL
     ${after ? `AND o.id > '${after}'::uuid` : ''}
   ORDER BY o.id
   LIMIT ${n}
), cls AS (
  SELECT o.id, ${CLASSIFY_FN('o.source_type', 'o.external_source', 'o.external_order_id', 'o.prediction_list_id', 'o.price', 'o.product_name')} AS c
    FROM public.orders o JOIN todo t ON t.id = o.id
), upd AS (
  UPDATE public.orders o
     SET sale_source = cls.c[1], sale_source_detail = cls.c[2]
    FROM cls
   WHERE o.id = cls.id AND o.sale_source IS NULL
  RETURNING o.id
)
SELECT (SELECT count(*) FROM todo)::int AS scanned,
       (SELECT count(*) FROM upd)::int AS updated,
       (SELECT id::text FROM todo ORDER BY id DESC LIMIT 1) AS last_id;`;

/** Pass B: duplicates inherit their original's stored source (one level per call). */
const passBSql = () => `${CHUNK_PRELUDE}
WITH upd AS (
  UPDATE public.orders d
     SET sale_source = p.sale_source, sale_source_detail = p.sale_source_detail
    FROM public.orders p
   WHERE d.duplicated_from = p.id
     AND d.sale_source IS NULL
     AND p.sale_source IS NOT NULL
  RETURNING d.id
)
SELECT count(*)::int AS updated FROM upd;`;

/** Last resort for a duplicate whose original never gets a source (a cycle). */
const passBFallbackSql = () => `${CHUNK_PRELUDE}
WITH cls AS (
  SELECT o.id, ${CLASSIFY_FN('o.source_type', 'o.external_source', 'o.external_order_id', 'o.prediction_list_id', 'o.price', 'o.product_name')} AS c
    FROM public.orders o
   WHERE o.duplicated_from IS NOT NULL AND o.sale_source IS NULL
), upd AS (
  UPDATE public.orders o SET sale_source = cls.c[1], sale_source_detail = cls.c[2]
    FROM cls WHERE o.id = cls.id AND o.sale_source IS NULL
  RETURNING o.id
)
SELECT count(*)::int AS updated FROM upd;`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(label, fn, log) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      // A chunk is one transaction: on error nothing of it was written, so a
      // retry is safe. Lock/statement timeouts and gateway errors are worth two
      // more tries; anything else is a bug and stops the run.
      const msg = String(e.message || e);
      const retryable = /lock timeout|canceling statement|deadlock|Management API (5\d\d|429|408)|fetch failed|ECONNRESET/i.test(msg);
      if (!retryable || i >= 3) throw e;
      log(yellow(`  ! ${label} failed (${msg.slice(0, 160)}) — retry ${i}/2`));
      await sleep(3000 * i);
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function run({ sql, sqlRead = (q) => sql(q, { readOnly: true }), argv = [], log = console.log, stamp, exportDir = EXPORT_DIR }) {
  const args = parseArgs(argv);
  if (args.help) {
    log('usage: node scripts/backfill-sale-source.mjs [--apply] [--limit n] [--chunk n] [--pause-ms n]');
    return { help: true };
  }
  stamp = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  log(bold(`\nSale-source backfill`) + ` — ${MK_REF}`);
  log(args.apply ? yellow('MODE: APPLY (writes orders.sale_source / sale_source_detail)') : cyan('MODE: dry run (read-only) — pass --apply to write'));

  // Second net: the remote must look like Macedonia (+389), not Bulgaria (+359).
  const [fp] = await sqlRead(`SELECT count(*)::int AS n, count(*) FILTER (WHERE customer_phone LIKE '+359%')::int AS bg FROM public.orders;`);
  if (!fp || !fp.n) refuse('The remote has no orders — this is not the Macedonian CRM.');
  if (fp.bg / fp.n > 0.2) refuse(`The remote has ${fp.bg}/${fp.n} orders on +359 phones — this looks like LIVE BULGARIA.`);
  log(`${green('✓')} remote ${MK_REF} — ${num(fp.n)} orders, ${num(fp.bg)} on +359`);

  const [pre] = await sqlRead(`
    SELECT to_regprocedure('${CLASSIFY_SIG}') IS NOT NULL AS has_fn,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sale_source') AS has_col,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'sale_source_detail') AS has_det;`);
  const hasFn = !!pre?.has_fn; const hasCol = !!(pre?.has_col && pre?.has_det);
  if (!hasFn || !hasCol) {
    log(yellow(`! migration 20260935000000 is not applied yet (function ${hasFn ? 'present' : 'missing'}, columns ${hasCol ? 'present' : 'missing'}) — matrix computed with the script's SQL twin`));
  }

  log(bold('\n── matrix ──'));
  const rows = await sqlRead(matrixSql({ hasCol, hasFn }));
  printMatrix(rows, log);
  const file = writeCsv(rows, stamp, exportDir);
  log(`\n  matrix written to ${file}`);

  const toFill = rows.reduce((s, r) => s + r.to_fill, 0);
  const drift = rows.reduce((s, r) => s + r.drift, 0);
  const mismatch = rows.reduce((s, r) => s + r.twin_mismatch, 0);
  const chains = rows.reduce((s, r) => s + r.chains, 0);
  if (drift) log(yellow(`  ! ${num(drift)} already-classified rows differ from the classifier today — write-once, left as they are (investigate if unexpected)`));
  if (chains) log(yellow(`  ! ${num(chains)} duplicates of duplicates — the preview classifies one level; pass B resolves the chain`));
  if (hasFn) {
    if (mismatch) log(red(`  ✗ the script's SQL twin disagrees with classify_sale_source() on ${num(mismatch)} rows — fix the twin before any apply`));
    else log(`${green('✓')} SQL twin == classify_sale_source() on every row`);
  }

  const summary = { orders: fp.n, to_fill: toFill, drift, twin_mismatch: mismatch, chains, matrix: rows, csv: file };
  if (!args.apply) {
    log(cyan(`\nDry run complete — ${num(toFill)} rows would be filled. Review the matrix, then re-run with --apply (quiet window).\n`));
    return summary;
  }

  // ── APPLY ─────────────────────────────────────────────────────────────────
  if (!hasFn || !hasCol) refuse('apply needs migration 20260935000000 (classify_sale_source + the two columns) — apply it first.');
  if (mismatch) refuse('the SQL twin and the function disagree — the reviewed matrix is not what would be written. Fix the twin first.');
  if (!toFill) { log(green('\n✓ nothing to fill — every order already has a sale_source.\n')); return { ...summary, updated: 0 }; }

  log(bold(`\n── pass A: originals, ${num(args.chunk)} per transaction ──`));
  let after = null; let updatedA = 0; let scannedA = 0;
  for (let i = 0; ; i++) {
    const want = args.limit ? Math.min(args.chunk, args.limit - updatedA) : args.chunk;
    if (want <= 0) break;
    const [r] = await withRetry(`chunk ${i + 1}`, () => sql(passASql(after, want)), log);
    if (!r || !r.scanned) break;
    scannedA += r.scanned; updatedA += r.updated; after = r.last_id;
    if (typeof process !== 'undefined' && process.stdout?.isTTY) process.stdout.write(`\r  filled ${num(updatedA)} (scanned ${num(scannedA)})   `);
    if (r.scanned < want) break;
    if (args.pauseMs) await sleep(args.pauseMs);
  }
  if (process.stdout?.isTTY) process.stdout.write('\n');
  log(`  pass A filled ${bold(num(updatedA))} originals`);

  let updatedB = 0; let fallback = 0;
  if (!args.limit) {
    log(bold('\n── pass B: duplicates inherit their original ──'));
    for (let depth = 0; depth < 10; depth++) {
      const [r] = await withRetry('pass B', () => sql(passBSql()), log);
      updatedB += r?.updated || 0;
      if (!r?.updated) break;
    }
    const [f] = await withRetry('pass B fallback', () => sql(passBFallbackSql()), log);
    fallback = f?.updated || 0;
    log(`  pass B filled ${bold(num(updatedB))} duplicates${fallback ? yellow(` · ${num(fallback)} fell back to their own columns (original never classified)`) : ''}`);
  } else {
    log(yellow('  --limit set: pass B (duplicates) skipped — run without --limit to finish'));
  }

  // ── prove it (C12: sale_source never NULL) ────────────────────────────────
  const [left] = await sqlRead(`SELECT count(*) FILTER (WHERE sale_source IS NULL)::int AS nulls, count(*)::int AS n FROM public.orders;`);
  const after2 = await sqlRead(`
    SELECT sale_source, sale_source_detail AS detail, count(*)::int AS n, round(coalesce(sum(price), 0)::numeric, 2)::text AS eur
      FROM public.orders GROUP BY 1, 2 ORDER BY 3 DESC;`);
  log(bold('\n  stored now:'));
  for (const r of after2) log(`  ${String(r.sale_source ?? 'NULL').padEnd(10)} ${String(r.detail ?? '').padEnd(16)} ${num(r.n).padStart(8)} ${eur(r.eur).padStart(14)}`);
  if (left.nulls) log(yellow(`\n  ! ${num(left.nulls)} of ${num(left.n)} orders still have no sale_source${args.limit ? ' (expected with --limit)' : ' — investigate'}`));
  else log(green(`\n✓ every one of ${num(left.n)} orders has a sale_source (C12)\n`));
  return { ...summary, updated: updatedA + updatedB + fallback, updated_a: updatedA, updated_b: updatedB, fallback, nulls_left: left.nulls };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function isMain() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const called = resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === called.toLowerCase() : me === called;
}

if (isMain()) {
  try {
    const api = mkApi();
    await run({ ...api, argv: process.argv.slice(2) });
  } catch (e) {
    console.error(red(`✗ ${e instanceof Refusal ? e.message : (e.stack || e.message || e)}`));
    process.exit(1);
  }
}
