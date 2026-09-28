#!/usr/bin/env node
/**
 * import-catalogue-products — every product that had a sale must exist in the CRM catalogue
 * (owner, 28.09.2026: "Which names aren't in the catalogue? We need all the products in the
 * CRM that had sales.")
 *
 *   node scripts/import-catalogue-products.mjs                        # DRY RUN (read-only)
 *   node scripts/import-catalogue-products.mjs --apply --run <id> [--actor mile@elyon.com]
 *   node scripts/import-catalogue-products.mjs --rollback --run <id> [--apply] [--actor …]
 *   node scripts/import-catalogue-products.mjs --explain --run <id>   # EXPLAIN the INSERTs read-only (preflight)
 *   options: --no-third-party   leave the web shop's resold cosmetics (Aura, Wet n Wild, Оливал …)
 *                               out of the catalogue (they stay in the review file)
 *
 * WHAT IT READS (read-only, Management API as supabase_read_only_user): every line of every
 * SALE in THE cohort (insights_sale_rows … in_total — exactly the Sales tab's line set: CRM
 * order_items, web_order_items; collabBox teleshop orders are CRM rows with sale_source
 * collabbox), all history in ≤ 6-month windows, with the Sales tab's value allocation (the
 * sale's value spread over its lines, to the denar) and its structural line kinds.
 *
 * WHAT IT DECIDES (scripts/lib/catalogue-match-mk.mjs — pure): for every name whose lines carry
 * no product_id, the line kind and a catalogue match with a confidence (exact · strong · weak ·
 * none). Only these are ever written:
 *   • product_aliases rows for exact (source 'any') and strong (one row per source it sold in)
 *   • product_aliases kind rows for ПОЕН (loyalty_point), ДОСТАВА (delivery), ЗАБЕЛЕШКА / delivery
 *     instructions (note), флаер (flyer), маталка / чашка (gift) — source 'any', product_id NULL
 *   • NEW public.products rows for an identified product the catalogue lacks, and their aliases
 * Weak / none / services / bundles go to the owner's file only.
 *
 * NEW PRODUCTS: is_active = false (the only flag the catalogue has — ProductCombobox, i.e. the
 * agents' order form, lists active products only; /products and /warehouse list them with a
 * "disabled" badge; insights name them), price 0 and cost_price 0 (nothing invented — the owner
 * prices them), stock 0, low_stock_threshold 0, category "Без каталог — од продажби", sku from
 * the set_product_sku trigger (SKU-0000NN). Their id is a deterministic UUID of the product key,
 * so a re-run never creates a product twice.
 *
 * ALIASES are written with reviewed_by / reviewed_at NULL and a note starting "AUTO … чека
 * одобрување". ⚠ product_key() / order_line_kind() do NOT filter on reviewed_by: an applied row
 * takes effect in every insights report at once. Apply only after the owner has seen the file.
 *
 * THE PROTOCOL (repair-kit style, but the dry run writes NOTHING to the database):
 *   dry run   classify → exports/products/<date>-analysis.json (+ the xlsx via
 *             scripts/build-uncatalogued-products-xlsx.py) → a local run file
 *             exports/products/runs/<run id>.json holding the plan and its sha256 → print the id.
 *   --apply   re-classify, refuse unless the hash equals the run file's, then ONE transaction:
 *             products (skipped when that id or name already exists), aliases (ON CONFLICT DO
 *             NOTHING — an existing, reviewed row always wins), a data_repair_runs row (dry_run =
 *             false, applied_at, applied_by) and one audit_log row.
 *   --rollback removes this run's still-unreviewed aliases and the products it created that no
 *             order line references (dry run unless --apply).
 *
 * 🛑 MACEDONIA ONLY: scripts/assert-mk-target.mjs runs first; repair-kit's mkGuard() pins the
 * ref and refuses any config that mentions the live Bulgarian project.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ROOT, MKD_PER_EUR, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, q, qUuid, qJson,
  candidateHash, canonicalJson, resolveActor, die, ok, warn, bold, yellow, green, fmtMkd, isUuid,
} from './lib/repair-kit.mjs';
import {
  classifyName, exactKey, cleanSpelling, canonicalOf, sizeSig, stableUuid, NEW_PRODUCTS,
} from './lib/catalogue-match-mk.mjs';

const KEY = 'import-catalogue-products';
const OUT_DIR = join(ROOT, 'exports', 'products');
const RUN_DIR = join(OUT_DIR, 'runs');
const NEW_CATEGORY = 'Без каталог — од продажби';
const TP_CATEGORY = 'Без каталог — трета страна (веб)';
const HISTORY_FROM = '2022-01-01';        // first web order: 2022-05-21; first CRM order: 2025-04-23
const SOURCES = ['crm', 'collabbox', 'web'];

const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'rollback', 'no-third-party', 'explain'], values: ['run', 'actor'] });
const options = { thirdParty: !args['no-third-party'] };

// ─── guards ─────────────────────────────────────────────────────────────────
console.log(bold(`\n=== ${KEY} ${args.rollback ? '(ROLLBACK' + (args.apply ? ' — APPLYING)' : ' — dry run)') : args.apply ? '(APPLYING)' : '(DRY RUN — read-only)'} ===`));
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch { die('scripts/assert-mk-target.mjs failed — refusing.'); }
mkGuard();
await assertRemoteIsMk();
mkdirSync(RUN_DIR, { recursive: true });

if (args.rollback) { await rollback(); process.exit(0); }

// ─── load (read-only) ───────────────────────────────────────────────────────
const [schema] = await sqlRead(`select to_regclass('public.product_aliases') is not null as aliases,
  to_regprocedure('public.insights_sale_rows(timestamptz,timestamptz,boolean)') is not null as rows_fn,
  to_regprocedure('public.product_alias_norm(text)') is not null as norm_fn`);
if (!schema?.aliases || !schema.rows_fn || !schema.norm_fn) die('apply 20260940000000_insights_foundation.sql first (product_aliases / insights_sale_rows / product_alias_norm missing).');

const catalogue = await sqlRead(`select id, name, sku, barcode, is_active, coalesce(category, '') as category,
  price::float8 as price, cost_price::float8 as cost_price, stock_quantity, created_at from public.products order by name`);
const existingAliases = await sqlRead(`select source, alias_norm, product_id, kind, reviewed_by is not null as reviewed, note from public.product_aliases`);
const cbMapFile = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json'), 'utf8'));

/** The Sales tab's line set and value allocation (20260941000100 `ln0` … `lv`), per window. */
const linesSql = (f, t) => `
WITH
rt AS MATERIALIZED (
  SELECT row_number() OVER () AS rid, s.kind, s.sale_source, s.value_mkd, s.order_id, s.web_id, s.display_id, s.sale_day
  FROM public.insights_sale_rows(${q(`${f} 00:00:00 Europe/Skopje`)}::timestamptz,
                                 ${q(`${t} 00:00:00 Europe/Skopje`)}::timestamptz - interval '1 microsecond', false) s
  WHERE s.in_total
),
ln0 AS MATERIALIZED (
  SELECT rt.rid, rt.sale_source, rt.value_mkd, rt.sale_day, rt.display_id AS ref, oi.id::text AS lid,
         CASE WHEN rt.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_id AS pid, oi.product_name AS name, NULL::text AS sku,
         greatest(coalesce(oi.quantity, 0), 0) AS qty,
         greatest(coalesce(oi.total_price, 0), 0)::numeric AS w, NULL::text AS shop_kind
  FROM rt JOIN public.order_items oi ON oi.order_id = rt.order_id
  WHERE rt.kind = 'order'
  UNION ALL
  SELECT rt.rid, NULL, rt.value_mkd, rt.sale_day, coalesce(wo.order_number, rt.web_id::text), 'w' || i.shop_item_id::text,
         'web', NULL::uuid, i.name, nullif(btrim(i.sku), ''),
         greatest(coalesce(i.quantity, 0), 0),
         greatest(coalesce(i.price, 0) * coalesce(i.quantity, 0) - coalesce(i.discount_allocated, 0), 0)::numeric, i.kind
  FROM rt JOIN public.web_order_items i ON i.shop_order_id = rt.web_id
  LEFT JOIN public.web_orders wo ON wo.shop_order_id = rt.web_id
  WHERE rt.kind = 'web'
),
ln1 AS MATERIALIZED (
  SELECT l.*, public.product_alias_norm(l.name) AS norm,
         CASE WHEN l.shop_kind = 'GIFT' THEN 'gift'
              WHEN lower(coalesce(l.name, '')) ~ '^\\s*(поен|poen)(и|i)?([^[:alpha:]]|$)' THEN 'loyalty_point'
              WHEN lower(coalesce(l.name, '')) ~ '^\\s*(достава|dostava|delivery|shipping)([^[:alpha:]]|$)' THEN 'delivery'
              ELSE 'product' END AS kind0
  FROM ln0 l
),
ln2 AS (
  SELECT l.*,
         (CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END)::numeric AS pq,
         sum(l.w) OVER wp AS sw, sum(l.w) OVER wr AS cw,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wp AS sq,
         sum(CASE WHEN l.kind0 = 'product' THEN greatest(l.qty, 1) ELSE 0 END) OVER wr AS cq
  FROM ln1 l
  WINDOW wp AS (PARTITION BY l.rid),
         wr AS (PARTITION BY l.rid ORDER BY l.w DESC, (l.kind0 = 'product') DESC, l.qty DESC, l.lid
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
),
lv AS MATERIALIZED (
  SELECT z.*, (z.lkind = 'product' AND z.qty > 20 AND z.val < 60 * z.qty) AS bad_qty
  FROM (SELECT l.rid, l.src, l.sale_source, l.pid, l.name, l.norm, l.sku, l.qty, l.sale_day, l.ref, l.shop_kind, l.w,
               CASE WHEN l.kind0 = 'product' AND l.w = 0 AND l.sw > 0 THEN 'gift' ELSE l.kind0 END AS lkind,
               CASE WHEN l.sw > 0 THEN round(l.value_mkd * l.cw / l.sw) - round(l.value_mkd * (l.cw - l.w) / l.sw)
                    WHEN l.sq > 0 THEN round(l.value_mkd * l.cq / l.sq) - round(l.value_mkd * (l.cq - l.pq) / l.sq)
                    ELSE 0::numeric END AS val
        FROM ln2 l) z
)
SELECT lv.src, coalesce(lv.sale_source, '') AS ss, lv.pid, lv.name, lv.norm, lv.lkind, (lv.pid IS NULL) AS nopid,
       grouping(lv.pid, lv.name, lv.lkind)::int AS g,
       count(*)::int AS lines, count(DISTINCT lv.rid)::int AS sales,
       sum(CASE WHEN lv.bad_qty THEN 0 ELSE lv.qty END)::int AS units,
       sum(lv.val)::float8 AS v,
       min(lv.sale_day)::text AS d_min, max(lv.sale_day)::text AS d_max,
       (array_agg(lv.ref ORDER BY lv.sale_day DESC, lv.ref))[1:3] AS refs
FROM lv
GROUP BY GROUPING SETS ((lv.src, lv.sale_source, lv.pid, lv.name, lv.norm, lv.lkind),
                        (lv.src, lv.sale_source, (lv.pid IS NULL), lv.norm))`;

function windows() {
  const out = [];
  const end = new Date(Date.now() + 2 * 86_400_000);
  let d = new Date(`${HISTORY_FROM}T00:00:00Z`);
  while (d < end) {
    const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 6);
    out.push([d.toISOString().slice(0, 10), (n < end ? n : end).toISOString().slice(0, 10)]);
    d = n;
  }
  return out;
}

const detail = [];   // (src, ss, pid, name, norm, lkind) rows
const perNorm = [];  // (src, ss, norm) rows — distinct sales per name
for (const [f, t] of windows()) {
  const rows = await sqlRead(linesSql(f, t));
  for (const r of rows) {
    r.win = f;
    if (r.g === 0) detail.push(r); else if (r.nopid) perNorm.push(r);
  }
}
ok(`sale lines loaded: ${detail.length} line groups over ${windows().length} windows (${HISTORY_FROM} → today)`);

// ─── classification ─────────────────────────────────────────────────────────
const usage = new Map();   // product id → денари sold with that product_id (all history)
for (const r of detail) if (r.pid) usage.set(r.pid, (usage.get(r.pid) || 0) + Number(r.v));
const bySku = new Map(catalogue.map((p) => [String(p.sku), p]));
const byExact = new Map();
for (const p of catalogue) { const k = exactKey(p.name); if (!byExact.has(k)) byExact.set(k, []); byExact.get(k).push(p); }
const cbMap = new Map(cbMapFile.matched.map((e) => [String(e.collabbox_name).trim().replace(/\s+/g, ' ').toLowerCase(), e]));
const pickAmong = (ps) => [...ps].sort((a, b) => (usage.get(b.id) || 0) - (usage.get(a.id) || 0) || (b.is_active - a.is_active) || String(a.sku).localeCompare(String(b.sku)))[0];

const fmtD = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const groups = new Map();
for (const r of detail) {
  if (r.pid || r.norm === null) continue;
  const g = groups.get(r.norm) ?? { norm: r.norm, spellings: new Map(), sources: new Set(), by: {}, kinds: {}, units: 0, v: 0, lines: 0, sales: 0, dMin: null, dMax: null, refs: [] };
  g.spellings.set(r.name, (g.spellings.get(r.name) || 0) + r.lines);
  g.sources.add(r.src);
  const b = (g.by[`${r.src}:${r.ss}`] ??= { units: 0, v: 0, sales: 0 });
  b.units += r.units; b.v += Number(r.v);
  g.kinds[r.lkind] = (g.kinds[r.lkind] || 0) + r.lines;
  g.units += r.units; g.v += Number(r.v); g.lines += r.lines;
  if (!g.dMin || r.d_min < g.dMin) g.dMin = r.d_min;
  if (!g.dMax || r.d_max > g.dMax) g.dMax = r.d_max;
  for (const ref of r.refs || []) g.refs.push({ ref, d: r.d_max });
  groups.set(r.norm, g);
}
for (const r of perNorm) {
  const g = groups.get(r.norm);
  if (!g) continue;           // a name that only ever carried a product_id
  g.sales += r.sales;
  g.by[`${r.src}:${r.ss}`] && (g.by[`${r.src}:${r.ss}`].sales += r.sales);
}

const SRC_LABEL = { 'crm:altercpa': 'CRM · AlterCPA', 'crm:affiliate': 'CRM · affiliate', 'crm:elyon_crm': 'CRM · ElyonCRM',
  'crm:web': 'CRM · web', 'crm:legacy': 'CRM · legacy', 'collabbox:collabbox': 'collabBox телешоп', 'web:': 'веб-продавница' };
const srcLabel = (k) => SRC_LABEL[k] ?? `CRM · ${k.split(':')[1] || '—'}`;

const analysis = [];
for (const g of groups.values()) {
  const spellings = [...g.spellings.entries()].sort((a, b) => b[1] - a[1]);
  const top = spellings[0][0];
  const c = classifyName(top, { bySku, byExact, cbMap, sources: g.sources, pickAmong });
  const refs = [...new Map(g.refs.sort((a, b) => (a.d < b.d ? 1 : -1)).map((x) => [x.ref, x])).keys()].slice(0, 3);
  analysis.push({
    norm: g.norm, spelling: cleanSpelling(top),
    spellings: [...new Set(spellings.map(([s]) => cleanSpelling(s)))],
    sources: [...g.sources].sort(), where: Object.keys(g.by).sort().map(srcLabel),
    by: Object.fromEntries(Object.entries(g.by).map(([k, b]) => [srcLabel(k), { units: b.units, sales: b.sales, value_mkd: Math.round(b.v) }])),
    units: g.units, sales: g.sales, lines: g.lines, value_mkd: Math.round(g.v),
    first: fmtD(g.dMin), last: fmtD(g.dMax), refs,
    giftOnly: !g.kinds.product && !!g.kinds.gift,
    ...c,
  });
}
analysis.sort((a, b) => b.value_mkd - a.value_mkd || a.norm.localeCompare(b.norm));

// ─── the plan ───────────────────────────────────────────────────────────────
const aliasTaken = new Map(existingAliases.map((a) => [`${a.source}\u0001${a.alias_norm}`, a]));
const newProducts = new Map();   // key → { id, name, category, description, group }
const existingByExact = byExact;
function newProductFor(target) {
  const tp = target.newKey.startsWith('tp:');
  if (tp && !options.thirdParty) return null;
  const name = tp ? target.thirdPartyName : NEW_PRODUCTS[target.newKey].name;
  // the catalogue got it meanwhile (by hand, or an earlier run): link, never duplicate
  const already = existingByExact.get(exactKey(name));
  if (already?.length) return { id: pickAmong(already).id, name: pickAmong(already).name, existing: true };
  if (!newProducts.has(target.newKey)) {
    newProducts.set(target.newKey, {
      key: target.newKey, id: stableUuid(target.newKey, createHash), name,
      category: tp ? TP_CATEGORY : NEW_CATEGORY,
      group: tp ? 'thirdparty' : NEW_PRODUCTS[target.newKey].group,
    });
  }
  return newProducts.get(target.newKey);
}

const aliasRows = [];
const conflicts = [];
for (const a of analysis) {
  a.action = 'за сопственикот';
  a.inApply = false;
  let productId = null;
  let kind = a.kind;
  if (a.kind !== 'product') {
    a.action = `вид: ${a.kind}`;
  } else if (a.confidence === 'exact' || a.confidence === 'strong') {
    productId = a.target.productId;
    a.action = 'алијас → постоечки производ';
  } else if (a.confidence === 'none' && a.target?.newKey && !a.service) {
    const np = newProductFor(a.target);
    if (!np) { a.action = 'за сопственикот (трета страна — исклучено со --no-third-party)'; continue; }
    productId = np.id;
    a.target.productId = np.id;
    a.action = np.existing ? 'алијас → постоечки производ (веќе креиран)' : 'нов производ + алијас';
  } else continue;

  const srcs = a.kind !== 'product' || a.confidence === 'exact' ? ['any'] : a.sources;
  const planned = [];
  for (const source of srcs) {
    const taken = aliasTaken.get(`${source}\u0001${a.norm}`) || aliasTaken.get(`any\u0001${a.norm}`);
    if (taken) {
      if ((taken.product_id || null) !== (productId || null) || taken.kind !== kind) conflicts.push({ norm: a.norm, source, existing: taken, planned: { productId, kind } });
      continue;
    }
    planned.push({ source, alias_norm: a.norm, product_id: productId, kind, confidence: a.confidence,
      note: `AUTO ${new Date().toISOString().slice(0, 10)} · ${a.kind !== 'product' ? 'вид' : a.confidence} · ${a.reason}`.slice(0, 900) });
  }
  if (planned.length) { a.inApply = true; aliasRows.push(...planned); }
}

const lines = [
  ...aliasRows.map((r) => `alias:${r.source}:${r.alias_norm}:${r.kind}:${r.product_id ?? ''}`),
  ...[...newProducts.values()].map((p) => `product:${p.id}:${p.name}:${p.category}`),
];
const hash = candidateHash(lines);

// ─── before / after: the share of PRODUCT value that resolves to a catalogue product ───
const aliasIndex = new Map(aliasRows.map((r) => [`${r.source}\u0001${r.alias_norm}`, r]));
for (const x of existingAliases) aliasIndex.set(`${x.source}\u0001${x.alias_norm}`, { ...x, product_id: x.product_id });
function share(filter) {
  const s = { before: { v: 0, res: 0 }, after: { v: 0, res: 0 } };
  for (const r of detail) {
    if (!filter(r)) continue;
    const v = Number(r.v);
    if (r.lkind === 'product') { s.before.v += v; if (r.pid) s.before.res += v; }
    const al = r.pid ? null : (aliasIndex.get(`${r.src}\u0001${r.norm}`) || aliasIndex.get(`any\u0001${r.norm}`));
    const kind = al && al.kind !== 'product' ? al.kind : r.lkind;
    if (kind !== 'product') continue;
    s.after.v += v;
    if (r.pid || al?.product_id) s.after.res += v;
  }
  const pct = (x) => (x.v ? (100 * x.res) / x.v : 0);
  return { before_pct: pct(s.before), after_pct: pct(s.after), value_mkd: Math.round(s.before.v), before_unresolved_mkd: Math.round(s.before.v - s.before.res), after_unresolved_mkd: Math.round(s.after.v - s.after.res) };
}
const shares = { all: share(() => true) };
// September 2026 (the owner's example window): one dedicated read of that month
{
  const rows = await sqlRead(linesSql('2026-09-01', '2026-10-01'));
  const d2 = rows.filter((r) => r.g === 0);
  const saved = detail.splice(0, detail.length, ...d2);
  shares.sep2026 = share(() => true);
  detail.splice(0, detail.length, ...saved);
}

// ─── catalogue sheet: rows, usage and possible duplicates ───────────────────
const canon = new Map();
for (const p of catalogue) { const c = canonicalOf(p.name); if (c) { if (!canon.has(c)) canon.set(c, []); canon.get(c).push(p); } }
// Bionatural (Elyon's own line) vs Natura: a row is Bionatural when its name says so or the
// collabBox article mapped onto it is a "… BIONATURAL" article ("Alpha Male" = ALPHA MALE BIONATURAL 30.1).
// The *fix line exists only as Bionatural, so the flag cannot split "Neurofix" from "NEUROFIX BIONATURAL 30/1".
const cbBionatural = new Set(cbMapFile.matched.filter((e) => /bionatural/i.test(e.collabbox_name)).map((e) => e.product_id));
const FIX_LINE = new Set(['SKU-000076', 'SKU-000073', '001538', '001314', '001317', '001313', '001291', '001540', '001537', '001536', '001316', '001312']);
const sigOf = (p, c) => ({ ...sizeSig(p.name), bionatural: FIX_LINE.has(c) ? true : sizeSig(p.name).bionatural || cbBionatural.has(p.id) });
const conflictsSize = (a, b) => ['count', 'ml', 'g'].some((k) => a[k] && b[k] && a[k] !== b[k]) || a.bionatural !== b.bionatural;
const catalogueRows = catalogue.map((p) => {
  const c = canonicalOf(p.name);
  const mine = sigOf(p, c);
  const dups = (c ? canon.get(c) : []).filter((o) => o.id !== p.id && !conflictsSize(mine, sigOf(o, c)));
  return { id: p.id, name: p.name, sku: p.sku, active: p.is_active, category: p.category,
    price_mkd: Math.round(Number(p.price || 0) * MKD_PER_EUR), cost: Number(p.cost_price || 0) > 0,
    sold_mkd: Math.round(usage.get(p.id) || 0), stock: p.stock_quantity,
    duplicates: dups.map((o) => `${o.name} [${o.sku}]`) };
});

// ─── outputs ────────────────────────────────────────────────────────────────
const runId = randomUUID();
const stamp = new Date().toISOString().slice(0, 10);
const tally = {};
for (const a of analysis) {
  const k = a.kind !== 'product' ? `вид:${a.kind}` : a.service ? 'услуга' : a.thirdParty ? 'трета страна' : a.target?.newKey && a.confidence === 'none' ? 'нов производ' : a.confidence;
  tally[k] ??= { names: 0, value_mkd: 0, applied: 0 };
  tally[k].names++; tally[k].value_mkd += a.value_mkd; if (a.inApply) tally[k].applied++;
}
const aliasTally = {};
for (const r of aliasRows) { const k = r.kind !== 'product' ? `kind:${r.kind}` : r.confidence === 'none' ? 'new-product' : r.confidence; aliasTally[k] = (aliasTally[k] || 0) + 1; }
const summary = {
  names: analysis.length, value_mkd: analysis.reduce((s, a) => s + a.value_mkd, 0), tally, alias_rows: aliasRows.length, alias_tally: aliasTally,
  new_products: newProducts.size, new_products_third_party: [...newProducts.values()].filter((p) => p.group === 'thirdparty').length,
  conflicts: conflicts.length, shares, options, lines: lines.length,
};
// files only on a dry run: an --apply / --explain re-classifies to check the hash, it does not mint a new run
const isDry = !args.apply && !args.explain;
const analysisFile = join(OUT_DIR, `${stamp}-analysis.json`);
const runFile = join(RUN_DIR, `${runId}.json`);
if (isDry) {
  writeFileSync(analysisFile, JSON.stringify({ generated: new Date().toISOString(), run_id: runId, hash, summary, rows: analysis,
    catalogue: catalogueRows, new_products: [...newProducts.values()], conflicts }, null, 1));
  writeFileSync(runFile, JSON.stringify({ id: runId, key: KEY, created_at: new Date().toISOString(), hash, options, summary,
    plan: { aliases: aliasRows, products: [...newProducts.values()] } }, null, 1));
}

// ─── report ─────────────────────────────────────────────────────────────────
console.log(`\n${bold('Names with sales and no catalogue product')} (all history): ${analysis.length} · ${fmtMkd(summary.value_mkd)} ден`);
console.table(Object.entries(tally).sort((a, b) => b[1].value_mkd - a[1].value_mkd).map(([k, t]) => ({ класа: k, имиња: t.names, 'вредност ден': fmtMkd(t.value_mkd), 'во apply': t.applied })));
console.log(`${bold('Apply set')}: ${aliasRows.length} product_aliases rows ${JSON.stringify(aliasTally)} · ${newProducts.size} new products (${summary.new_products_third_party} third-party)`);
if (conflicts.length) warn(`${conflicts.length} names already have a DIFFERENT alias row — left alone (listed in the analysis file)`);
const pctS = (x) => `${x.toFixed(1).replace('.', ',')} %`;
console.log(`${bold('Product value resolving to a catalogue product')}:`);
console.log(`  all history   ${pctS(shares.all.before_pct)} → ${green(pctS(shares.all.after_pct))}   (unresolved ${fmtMkd(shares.all.before_unresolved_mkd)} → ${fmtMkd(shares.all.after_unresolved_mkd)} ден of ${fmtMkd(shares.all.value_mkd)})`);
console.log(`  September 2026 ${pctS(shares.sep2026.before_pct)} → ${green(pctS(shares.sep2026.after_pct))}   (unresolved ${fmtMkd(shares.sep2026.before_unresolved_mkd)} → ${fmtMkd(shares.sep2026.after_unresolved_mkd)} ден of ${fmtMkd(shares.sep2026.value_mkd)})`);
console.log(isDry ? `\n  analysis: ${analysisFile}\n  run file: ${runFile}\n  hash    : ${hash.slice(0, 16)}…` : `\n  hash    : ${hash.slice(0, 16)}…`);

if (!args.apply && !args.explain) {
  console.log(`\n${bold('DRY RUN — nothing was written to the database.')}  Run id: ${bold(runId)}`);
  console.log(`  Build the owner file:  python scripts/build-uncatalogued-products-xlsx.py "${analysisFile}"`);
  console.log(`  Apply (after the owner's review):  node scripts/import-catalogue-products.mjs --apply --run ${runId}${options.thirdParty ? '' : ' --no-third-party'}`);
  process.exit(0);
}

// ─── apply ──────────────────────────────────────────────────────────────────
if (!args.run || !isUuid(args.run)) die('--apply / --explain need --run <id> printed by a dry run.');
const recFile = join(RUN_DIR, `${args.run}.json`);
if (!existsSync(recFile)) die(`no run file ${recFile}`);
const rec = JSON.parse(readFileSync(recFile, 'utf8'));
if (rec.key !== KEY) die(`run ${args.run} is not a ${KEY} run.`);
if (canonicalJson(rec.options) !== canonicalJson(options)) die(`run ${args.run} was dry-run with options ${canonicalJson(rec.options)} — pass the same flags.`);
if (rec.hash !== hash) die(`The plan changed since that dry run (hash ${hash.slice(0, 12)}… ≠ ${rec.hash.slice(0, 12)}…). Dry-run again, review, apply THAT id.`);
const [done] = await sqlRead(`select count(*)::int as n from public.data_repair_runs where key = ${q(KEY)} and summary->>'run_id' = ${q(args.run)}`);
if (done?.n) die(`run ${args.run} was already applied.`);
ok(`hash matches the dry run (${hash.slice(0, 12)}…)`);

const noteRun = (n) => `${n} · run ${args.run} · чека одобрување од сопственикот`.slice(0, 1000);
const prodValues = [...newProducts.values()].map((p) => `(${qUuid(p.id)}, ${q(p.name)}, ${q(`Креиран автоматски (${KEY}, run ${args.run}): име што имало продажби, а го немало во каталогот. Цена и набавна цена ги внесува сопственикот.`)}, ${q(p.category)})`);
const aliasValues = aliasRows.map((r) => `(${q(r.source)}, ${q(r.alias_norm)}, ${r.product_id ? qUuid(r.product_id) : 'NULL::uuid'}, ${q(r.kind)}, ${q(noteRun(r.note))})`);
const insertProducts = prodValues.length ? `INSERT INTO public.products (id, name, description, price, cost_price, is_active, stock_quantity, low_stock_threshold, category)
SELECT v.id, v.name, v.description, 0, 0, false, 0, 0, v.category
FROM (VALUES ${prodValues.join(',\n')}) v(id, name, description, category)
WHERE NOT EXISTS (SELECT 1 FROM public.products p WHERE p.id = v.id)
  AND NOT EXISTS (SELECT 1 FROM public.products p WHERE lower(btrim(p.name)) = lower(btrim(v.name)))` : null;
const insertAliases = aliasValues.length ? `INSERT INTO public.product_aliases (source, alias_norm, product_id, kind, note)
VALUES ${aliasValues.join(',\n')}
ON CONFLICT (source, alias_norm) DO NOTHING` : null;

if (args.explain) {
  // Preflight, READ-ONLY (the read-only role may not even EXPLAIN an INSERT): run the exact VALUES
  // lists through SELECTs that check what the INSERTs would hit — types, CHECKs, FKs, conflicts.
  const newIds = [...newProducts.values()].map((p) => qUuid(p.id));
  if (prodValues.length) {
    const [p] = await sqlRead(`SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.products x WHERE x.id = v.id::uuid))::int AS id_exists,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.products x WHERE lower(btrim(x.name)) = lower(btrim(v.name))))::int AS name_exists
      FROM (VALUES ${prodValues.join(',\n')}) v(id, name, description, category)`);
    ok(`products: ${p.rows} rows would insert · ${p.id_exists} id already present · ${p.name_exists} name already present (either blocks the apply's aliases → it fails whole)`);
  }
  if (aliasValues.length) {
    const [a] = await sqlRead(`SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE v.source NOT IN ('crm','collabbox','web','altercpa','mex','any'))::int AS bad_source,
        count(*) FILTER (WHERE v.kind NOT IN ('product','gift','loyalty_point','delivery','note','flyer'))::int AS bad_kind,
        count(*) FILTER (WHERE coalesce(v.alias_norm, '') = '' OR v.alias_norm IS DISTINCT FROM public.product_alias_norm(v.alias_norm))::int AS bad_norm,
        count(*) FILTER (WHERE v.product_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.products x WHERE x.id = v.product_id)
                           AND v.product_id <> ALL (${newIds.length ? `ARRAY[${newIds.join(',')}]` : 'ARRAY[]::uuid[]'}))::int AS dangling_fk,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.product_aliases x WHERE x.source = v.source AND x.alias_norm = v.alias_norm))::int AS already_there,
        (SELECT count(*) FROM (SELECT v2.source, v2.alias_norm FROM (VALUES ${aliasValues.join(',\n')}) v2(source, alias_norm, product_id, kind, note)
                               GROUP BY 1, 2 HAVING count(*) > 1) d)::int AS dup_keys
      FROM (VALUES ${aliasValues.join(',\n')}) v(source, alias_norm, product_id, kind, note)`);
    const bad = a.bad_source + a.bad_kind + a.bad_norm + a.dangling_fk + a.dup_keys;
    (bad ? warn : ok)(`product_aliases: ${a.rows} rows · bad source ${a.bad_source} · bad kind ${a.bad_kind} · key ≠ product_alias_norm ${a.bad_norm} · dangling product_id ${a.dangling_fk} · duplicate keys ${a.dup_keys} · already present (skipped by ON CONFLICT) ${a.already_there}`);
  }
  process.exit(0);
}
const actor = await resolveActor(args.actor || 'mile@elyon.com');
const payload = { run_id: args.run, hash, aliases: aliasRows.length, products: newProducts.size, options, shares };
const applySql = `
SET LOCAL lock_timeout = '5s';
${insertProducts ? `${insertProducts};` : ''}
${insertAliases ? `${insertAliases};` : ''}
INSERT INTO public.data_repair_runs (id, key, dry_run, candidate_hash, summary, applied_at, applied_by)
VALUES (gen_random_uuid(), ${q(KEY)}, false, ${q(hash)}, ${qJson({ ...summary, run_id: args.run })}, now(), ${qUuid(actor.id)});
INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
VALUES (${qUuid(actor.id)}, ${q(actor.email)}, 'catalogue.import_from_sales', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(payload)});
SELECT (SELECT count(*) FROM public.product_aliases WHERE note LIKE ${q(`%run ${args.run}%`)})::int AS aliases,
       (SELECT count(*) FROM public.products WHERE description LIKE ${q(`%run ${args.run}%`)})::int AS products;`;
const [res] = await sql(applySql);
ok(`applied as ${actor.email}: ${res?.aliases ?? '?'} alias rows, ${res?.products ?? '?'} new products (one transaction)`);
console.log(yellow('  The aliases are live in every insights report now; reviewed_by stays NULL until the owner approves.'));

// ─── rollback ───────────────────────────────────────────────────────────────
async function rollback() {
  if (!args.run || !isUuid(args.run)) die('--rollback needs --run <id>.');
  const like = q(`%run ${args.run}%`);
  const [n] = await sqlRead(`select
      (select count(*) from public.product_aliases where note like ${like} and reviewed_by is null)::int as aliases,
      (select count(*) from public.product_aliases where note like ${like} and reviewed_by is not null)::int as reviewed,
      (select count(*) from public.products p where p.description like ${like}
         and not exists (select 1 from public.order_items oi where oi.product_id = p.id)
         and not exists (select 1 from public.orders o where o.product_id = p.id))::int as products,
      (select count(*) from public.products p where p.description like ${like})::int as products_all`);
  console.log(`run ${args.run}: ${n.aliases} unreviewed alias rows (${n.reviewed} reviewed — kept), ${n.products}/${n.products_all} created products with no order line`);
  if (!args.apply) { console.log('dry run — add --apply to remove them.'); return; }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  await sql(`SET LOCAL lock_timeout = '5s';
    DELETE FROM public.product_aliases WHERE note LIKE ${like} AND reviewed_by IS NULL;
    DELETE FROM public.products p WHERE p.description LIKE ${like}
      AND NOT EXISTS (SELECT 1 FROM public.product_aliases a WHERE a.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.order_items oi WHERE oi.product_id = p.id)
      AND NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.product_id = p.id);
    INSERT INTO public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    VALUES (${qUuid(actor.id)}, ${q(actor.email)}, 'catalogue.import_from_sales_rollback', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(n)});`);
  ok('rolled back');
}
