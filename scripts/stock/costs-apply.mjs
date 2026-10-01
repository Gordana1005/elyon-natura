#!/usr/bin/env node
/**
 * costs-apply — load the Sigma purchase costs into the Macedonian CRM (Stock v2, owner decision 01.10.2026:
 * "purchase cost = Sigma CalcBuyPrice for EVERYTHING, for the WHOLE history"; contract docs/STOCK-V2.md "Costs").
 *
 *   node scripts/stock/costs-apply.mjs                         DRY RUN (default): everything runs inside ONE
 *                                                              transaction that is rolled back — nothing is written
 *   node scripts/stock/costs-apply.mjs --apply --actor <uuid>  the lead, after the dry run: writes it
 *
 *   --file <path>          default exports/stock/costs.json (workstream S, docs/stock/build_sigma_stock.py):
 *                          [{code, cost_mkd, source, basis, source_ref, flags[]}]
 *   --valid-from <ts>      default -infinity (the first load covers the whole history)
 *   --source-ref <text>    default "Sigma StockObject 2026-09-29" — used for a row without its own source_ref
 *   --actor <uuid>         the owner / admin recorded on every row and audit entry (required with --apply;
 *                          a dry run borrows the oldest admin when absent — nothing is kept)
 *   --no-rebuild           load the article costs only (product_cost_history is rebuilt later)
 *   --self-test            check the file parser on a built-in fixture (offline) and exit
 *
 * What it does:
 *   1. stock_article_costs_import(rows, valid_from, source_ref, actor, false) — append-only: an existing
 *      (article, valid_from, source) is never overwritten (unchanged / conflict); rows without a cost, unknown
 *      articles (load articles.json first: stock_articles_upsert), duplicates and invalid rows are counted and
 *      their CODES sampled — a cost value is never printed (business-confidential).
 *   2. product_costs_rebuild(actor, true) — product_cost_history from the APPROVED recipes, the legacy
 *      products.cost_price archived ONCE into products_cost_legacy, then the guarded mirror
 *      products.cost_price = cost_mkd / 61,5.
 *   3. A read-back: products costed now, the products sold in the last 90 days still without a cost (by
 *      sales — the recipes to approve first).
 *
 * Order (the lead): migrations 0100 → 0600 → articles (stock_articles_upsert) → recipes approved → this
 * script (dry, then --apply) → 0800 → the owner switches app_settings.stock_v2.profit.cost_source to 'sigma'
 * → refresh the profit cache (SELECT public.insights_profit_refresh_nightly(true, 10); ×3).
 * Re-running is safe: the import is append-only and the rebuild is idempotent.
 *
 * 🛑 MACEDONIA ONLY — scripts/lib/repair-kit.mjs mkGuard() + assertRemoteIsMk(); run
 * `node scripts/assert-mk-target.mjs` first. The access token is never printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, assertRemoteIsMk, bold, die, isUuid, mkGuard, ok, q, qJson, qUuid, sql, sqlRead, warn, yellow,
} from '../lib/repair-kit.mjs';

const DEFAULT_FILE = join(ROOT, 'exports', 'stock', 'costs.json');
const DEFAULT_REF = 'Sigma StockObject 2026-09-29';
const BASES = new Set(['04_calcbuy_qtyweighted', '04_calcbuy_single', '04_last_buyprice_2026', 'other_object', 'none']);
const SOURCES = new Set(['sigma_calcbuyprice', 'sigma_last_buyprice']);

/**
 * The contract file → the rows the SQL import takes, plus a summary. Pure (tested by --self-test).
 * Problems are reported, never fixed: the SQL import decides (no cost / unknown / invalid).
 */
export function parseCostsFile(json) {
  if (!Array.isArray(json)) throw new Error('costs.json must be a JSON array of {code, cost_mkd, source, basis, source_ref, flags}');
  const rows = [];
  const summary = { rows: json.length, with_cost: 0, no_cost: 0, bad_code: [], bad_source: [], bad_basis: [], duplicates: [], by_basis: {}, refs: {} };
  const seen = new Set();
  for (const r of json) {
    const code = String(r?.code ?? '').trim();
    const cost = r?.cost_mkd == null || r.cost_mkd === '' ? null : Number(r.cost_mkd);
    const basis = r?.basis == null ? null : String(r.basis);
    const source = r?.source == null ? null : String(r.source);
    const ref = r?.source_ref == null ? null : String(r.source_ref);
    if (!/^[0-9]{6}$/.test(code) && !/^L[0-9]{5}$/.test(code)) summary.bad_code.push(code || '∅');
    if (source !== null && !SOURCES.has(source)) summary.bad_source.push(code);
    if (basis !== null && !BASES.has(basis)) summary.bad_basis.push(code);
    const key = `${code}|${source ?? 'sigma_calcbuyprice'}`;
    if (seen.has(key)) summary.duplicates.push(code);
    seen.add(key);
    if (cost != null && Number.isFinite(cost) && cost > 0 && basis !== 'none') summary.with_cost++;
    else summary.no_cost++;
    summary.by_basis[basis ?? '∅'] = (summary.by_basis[basis ?? '∅'] ?? 0) + 1;
    if (ref) summary.refs[ref] = (summary.refs[ref] ?? 0) + 1;
    rows.push({
      code, cost_mkd: cost != null && Number.isFinite(cost) ? cost : null, source, basis, source_ref: ref,
      flags: Array.isArray(r?.flags) ? r.flags.map(String).slice(0, 20) : [],
    });
  }
  return { rows, summary };
}

function selfTest() {
  const fx = [
    { code: '001654', cost_mkd: 40.5, source: 'sigma_calcbuyprice', basis: '04_calcbuy_single', source_ref: 'Ф00001-04 StockObject 2026-09-30', flags: [] },
    { code: '001641', cost_mkd: 70, source: 'sigma_last_buyprice', basis: '04_last_buyprice_2026', source_ref: null, flags: ['no_stock_04'] },
    { code: '000999', cost_mkd: null, source: null, basis: 'none', source_ref: null, flags: [] },
    { code: 'X1', cost_mkd: 3, source: 'sigma_calcbuyprice', basis: '04_calcbuy_single', source_ref: null, flags: [] },
    { code: '001654', cost_mkd: 41, source: 'sigma_calcbuyprice', basis: '04_calcbuy_single', source_ref: null, flags: [] },
  ];
  const { rows, summary } = parseCostsFile(fx);
  const want = { rows: 5, with_cost: 4, no_cost: 1 };
  const fails = [];
  for (const [k, v] of Object.entries(want)) if (summary[k] !== v) fails.push(`${k} ${summary[k]} ≠ ${v}`);
  if (summary.bad_code.join() !== 'X1') fails.push(`bad_code ${summary.bad_code}`);
  if (summary.duplicates.join() !== '001654') fails.push(`duplicates ${summary.duplicates}`);
  if (rows[1].flags[0] !== 'no_stock_04' || rows[2].cost_mkd !== null) fails.push('row shape');
  let threw = false;
  try { parseCostsFile({}); } catch { threw = true; }
  if (!threw) fails.push('a non-array must be refused');
  if (fails.length) die(`self-test FAILED: ${fails.join('; ')}`);
  ok('self-test passed (parser, codes, duplicates, no-cost rows)');
}

function args(argv) {
  const o = { apply: false, file: DEFAULT_FILE, validFrom: '-infinity', sourceRef: DEFAULT_REF, actor: null, rebuild: true, selfTest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') o.apply = true;
    else if (a === '--file') o.file = argv[++i];
    else if (a === '--valid-from') o.validFrom = argv[++i];
    else if (a === '--source-ref') o.sourceRef = argv[++i];
    else if (a === '--actor') o.actor = argv[++i];
    else if (a === '--no-rebuild') o.rebuild = false;
    else if (a === '--self-test') o.selfTest = true;
    else die(`unknown argument ${a}`);
  }
  if (o.file && !isAbsolute(o.file)) o.file = join(process.cwd(), o.file);
  return o;
}

/** The read-back: what is costed now, and what still sells without a cost. Names and counts only. */
const READBACK = `
SELECT jsonb_build_object(
  'articles_costed', (SELECT count(DISTINCT c.article_code) FROM public.stock_article_costs c),
  'products_costed_now', (SELECT count(*) FROM public.product_cost_history h WHERE h.complete AND h.valid_from <= now() AND (h.valid_to IS NULL OR h.valid_to > now())),
  'products_incomplete_now', (SELECT count(*) FROM public.product_cost_history h WHERE NOT h.complete AND h.valid_from <= now() AND (h.valid_to IS NULL OR h.valid_to > now())),
  'legacy_archived', (SELECT count(*) FROM public.products_cost_legacy),
  'mirror_nonzero', (SELECT count(*) FROM public.products WHERE cost_price > 0),
  'sold_90d_uncosted', (SELECT coalesce(jsonb_agg(x ORDER BY x.lines DESC), '[]'::jsonb) FROM (
      SELECT p.name, p.kind, count(*) AS lines
        FROM public.order_items i
        JOIN public.orders o ON o.id = i.order_id
        JOIN public.products p ON p.id = i.product_id
       WHERE o.created_at > now() - interval '90 days'
         AND NOT EXISTS (SELECT 1 FROM public.product_cost_history h WHERE h.product_id = p.id AND h.complete
                           AND h.valid_from <= now() AND (h.valid_to IS NULL OR h.valid_to > now()))
       GROUP BY p.name, p.kind ORDER BY count(*) DESC LIMIT 15) x)
)`;

/**
 * The statements: the import, the rebuild, and the dry run — ONE transaction rolled back by the exception
 * that carries the result (base64: no quoting trouble). Exported for the dry-run harness.
 */
export function costsSql({ rows, validFrom, sourceRef, actor, rebuild }) {
  const imp = `public.stock_article_costs_import(${qJson(rows)}, ${q(validFrom)}::timestamptz, ${q(sourceRef)}, ${qUuid(actor)}, false)`;
  const reb = `public.product_costs_rebuild(${qUuid(actor)}, true)`;
  const dry = `DO $dry$
DECLARE v_imp jsonb; v_reb jsonb; v_now jsonb;
BEGIN
  v_imp := ${imp};
  ${rebuild ? `v_reb := ${reb};` : ''}
  v_now := (${READBACK});
  RAISE EXCEPTION 'COSTS_DRY:%', translate(encode(convert_to(jsonb_build_object('import', v_imp, 'rebuild', v_reb, 'now', v_now)::text, 'UTF8'), 'base64'), chr(10), '');
END $dry$;`;
  return { imp, reb, dry };
}

function printImport(r) {
  console.log(`  import   rows ${r.rows} · insert ${r.insert}${r.inserted != null ? ` (written ${r.inserted})` : ''} · unchanged ${r.unchanged} · conflict ${r.conflict}`
    + ` · no cost ${r.no_cost} · unknown article ${r.unknown_article} · duplicate ${r.duplicate} · invalid ${r.invalid}`);
  for (const [k, codes] of Object.entries(r.samples ?? {})) {
    if (codes?.length) console.log(`           ${k}: ${codes.slice(0, 12).join(', ')}${codes.length > 12 ? ' …' : ''}`);
  }
  if (r.unknown_article > 0) warn(`${r.unknown_article} codes are not in stock_articles — load exports/stock/articles.json first (stock_articles_upsert).`);
  if (r.conflict > 0) warn(`${r.conflict} articles already hold a DIFFERENT cost at this valid_from — append-only, kept as they are; load a later valid_from to change them.`);
}

function printRebuild(r) {
  console.log(`  rebuild  history rows ${r.rows} · products ${r.products} · complete now ${r.complete_now} · incomplete now ${r.incomplete_now}`
    + ` · exempt ${r.exempt} · uncosted articles in approved recipes ${r.uncosted_articles_now}`);
  console.log(`           legacy archived ${r.legacy_archived} (non-zero ${r.legacy_archived_nonzero}; already archived before: ${r.legacy_was_archived})`
    + ` · mirror ${r.mirror} (${r.mirror_updated} products)`);
}

function printReadback(r) {
  console.log(`  now      articles costed ${r.articles_costed} · products costed ${r.products_costed_now} · incomplete ${r.products_incomplete_now}`
    + ` · legacy rows ${r.legacy_archived} · products.cost_price > 0: ${r.mirror_nonzero}`);
  if (r.sold_90d_uncosted?.length) {
    console.log(yellow('  sold in the last 90 days without a cost (approve their recipes first):'));
    for (const x of r.sold_90d_uncosted) console.log(`           ${String(x.lines).padStart(6)} lines  ${x.name}${x.kind ? `  [${x.kind}]` : ''}`);
  }
}

async function main() {
  const o = args(process.argv.slice(2));
  if (o.selfTest) { selfTest(); return; }
  if (o.apply && !isUuid(o.actor)) die('--apply needs --actor <uuid> (the owner / admin who loads the costs).');
  if (o.actor && !isUuid(o.actor)) die('--actor must be a uuid.');
  if (!existsSync(o.file)) die(`${o.file} not found — workstream S writes it (docs/stock/build_sigma_stock.py → exports/stock/costs.json).`);
  if (o.validFrom !== '-infinity' && Number.isNaN(Date.parse(o.validFrom))) die(`--valid-from ${o.validFrom} is not a timestamp`);

  const { rows, summary } = parseCostsFile(JSON.parse(readFileSync(o.file, 'utf8')));
  console.log(bold(`costs-apply — ${o.apply ? 'APPLY' : 'DRY RUN (rolled back)'} · ${o.file}`));
  console.log(`  file     ${summary.rows} rows · with a cost ${summary.with_cost} · without ${summary.no_cost} · by basis ${JSON.stringify(summary.by_basis)}`);
  if (summary.bad_code.length) warn(`invalid codes: ${summary.bad_code.slice(0, 12).join(', ')}`);
  if (summary.bad_source.length) warn(`unknown source on: ${summary.bad_source.slice(0, 12).join(', ')}`);
  if (summary.bad_basis.length) warn(`unknown basis on: ${summary.bad_basis.slice(0, 12).join(', ')}`);
  if (summary.duplicates.length) warn(`duplicate codes: ${summary.duplicates.slice(0, 12).join(', ')}`);

  mkGuard();
  await assertRemoteIsMk();
  const [pre] = await sqlRead(`SELECT
      to_regprocedure('public.stock_article_costs_import(jsonb,timestamp with time zone,text,uuid,boolean)') IS NOT NULL AS has_import,
      to_regprocedure('public.product_costs_rebuild(uuid,boolean)') IS NOT NULL AS has_rebuild,
      (SELECT count(*) FROM public.stock_articles)::int AS articles,
      (SELECT count(*) FROM public.product_articles WHERE status = 'approved')::int AS approved_lines,
      (SELECT u.user_id::text FROM public.user_roles u WHERE u.role = 'admin' ORDER BY u.user_id LIMIT 1) AS some_admin`)
    .catch((e) => die(`the Stock v2 tables are not on MK yet (apply 20260945000100 and 0600 first): ${e.message.slice(0, 200)}`));
  if (!pre.has_import || !pre.has_rebuild) die('migration 20260945000600_stock_v2_costs.sql is not applied on MK.');
  ok(`MK has ${pre.articles} stock articles and ${pre.approved_lines} approved recipe lines`);
  if (pre.articles === 0) warn('stock_articles is empty — every row will come back as "unknown article". Load the articles first.');
  if (pre.approved_lines === 0) warn('no approved recipe lines — the rebuild costs no product yet (the costs still load).');

  const actor = o.actor ?? pre.some_admin;
  if (!isUuid(actor)) die('no actor: pass --actor <uuid>.');
  const { imp, reb, dry } = costsSql({ rows, validFrom: o.validFrom, sourceRef: o.sourceRef, actor, rebuild: o.rebuild });

  if (!o.apply) {
    const body = dry;
    let out = null;
    try { await sql(body); } catch (e) {
      const m = String(e.message).match(/COSTS_DRY:([A-Za-z0-9+/=]+)/);
      if (!m) die(`dry run failed: ${String(e.message).slice(0, 600)}`);
      out = JSON.parse(Buffer.from(m[1], 'base64').toString('utf8'));
    }
    if (!out) die('dry run: the transaction did not roll back as expected — check the database NOW.');
    printImport(out.import);
    if (out.rebuild) printRebuild(out.rebuild);
    printReadback(out.now);
    console.log(yellow('\nDRY RUN — rolled back, nothing written. Re-run with --apply --actor <uuid> to load.'));
    return;
  }

  const [i] = await sql(`SELECT ${imp} AS r`);
  printImport(i.r);
  if (o.rebuild) {
    const [r] = await sql(`SELECT ${reb} AS r`);
    printRebuild(r.r);
  }
  const [n] = await sqlRead(`SELECT (${READBACK}) AS r`);
  printReadback(n.r);
  ok('applied. Next: migration 20260945000800 (if not yet), the owner switches stock_v2.profit.cost_source to "sigma",');
  console.log('  then refresh the profit cache: SELECT public.insights_profit_refresh_nightly(true, 10);  (×3, or wait for 03:40 Skopje)');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.message ?? String(e)));
}
