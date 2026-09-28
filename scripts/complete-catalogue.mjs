#!/usr/bin/env node
/**
 * complete-catalogue — every product that is sold (or ever sold) exists in the CRM catalogue, and
 * every product sold in the last 60 days can be sold by the agents.
 * Owner, 28.09.2026: "Create all the products we don't have that are active at the moment and
 * being sold — even ones sold in the past. No purchase (cost) price needed for now."
 *
 *   node scripts/complete-catalogue.mjs                          # DRY RUN (read-only) → run id
 *   node scripts/complete-catalogue.mjs --include-active         # step 1 also fills ACTIVE rows (see below)
 *   node scripts/complete-catalogue.mjs --explain --run <id>     # read-only preflight of the apply's VALUES
 *   node scripts/complete-catalogue.mjs --apply --run <id> [--actor mile@elyon.com]
 *   node scripts/complete-catalogue.mjs --rollback --run <id> [--apply] [--actor …]
 *
 * THE LINE SET is the Sales tab's (insights_sale_rows … in_total: CRM order_items incl. the
 * imported collabBox teleshop orders, and web_order_items), all history in ≤ 6-month windows up
 * to the dry run's instant (`as_of`, kept in the run file so an --apply re-reads the SAME window),
 * with the Sales tab's value allocation (each sale's value spread over its lines, to the denar)
 * and its line kinds (a reviewed product_aliases kind first). "Sold" = a product line of such a
 * sale. "The last 60 days" = the Skopje day of `as_of` and the 59 before it.
 *
 * 1. ACTIVATE — a catalogue product sold in the last 60 days (through its product_id, an existing
 *    alias, or an alias this run adds) that is is_active = false →
 *      is_active = true · price = its typical sale price when price is 0 · stock_quantity 1000 and
 *      low_stock_threshold 5 when stock ≤ 0 (the rest of the catalogue's placeholder until the
 *      owner's count) · cost_price untouched. The stock move gets its inventory_logs row
 *      (manual / manual_adjust — the house rule of scripts/set-stock-mk.mjs).
 *    NOT activated (listed): a row with an ACTIVE twin (same product and pack — "КРЕАТИН ВО ПРАВ
 *    200ГР" next to the active "CREATINE powder 200 gr."): activating it would list the product
 *    twice in the agents' order form, and the product is already sellable. The 8 AlterCPA rows of
 *    28.09 are never touched.
 *    --include-active: ACTIVE rows sold in the last 60 days with price 0 or stock ≤ 0 get the same
 *    price / placeholder-stock fill (by default they are only listed).
 * 2. CREATE — the names that still resolve to no catalogue product (all history) are grouped
 *    (scripts/lib/complete-catalogue-mk.mjs — spelling / Latin–Cyrillic / notes folded, pack sizes
 *    and N+M sets never merged) and each group is decided:
 *      link    the same product as an existing row → aliases only (the row is activated by step 1
 *              when the link makes it "sold in the last 60 days")
 *      create  a new row: deterministic id, name = the most frequent clean spelling, category
 *              "Од продажби — collabBox/web (28.09.2026)", price = typical sale price, cost 0;
 *              sold in the last 60 days → active, stock 1000 / threshold 5; else inactive, stock 0
 *      unsure  listed for the owner, NOTHING written      exclude  non-products, never written
 *    + a product_aliases row (kind product, reviewed_by NULL, note "AUTO complete-catalogue 28.09 —
 *    чека одобрување · run <id> …") for EVERY spelling of a linked / created group, source 'any':
 *    a line's crm / collabbox source follows orders.sale_source, which the department reclass
 *    (reclass-by-folder.mjs) moves — a source-specific row would stop matching. A spelling that
 *    already has an alias row somewhere gets per-source rows instead (the existing row is kept).
 * TYPICAL SALE PRICE (EUR) = median денари per unit of the product's priced lines in the last 90
 * days ÷ 61,5, 2 decimals; when those 90 days hold fewer than 3 priced lines, the median of its
 * 20 most recent priced lines (the file says which basis and how many lines).
 *
 * ⚠ product_key() / order_line_kind() do not look at reviewed_by: an applied alias counts in every
 * insights report at once. Apply only after the owner has seen the file.
 *
 * THE PROTOCOL (the dry run writes NOTHING to the database):
 *   dry run    → exports/products/<date>-complete-plan[-include-active].json (+ .xlsx for the owner, + .csv) and
 *                exports/products/runs/<run id>.json (plan + sha256) → prints the run id.
 *   --apply    re-plans at the run's as_of, refuses unless the hash equals the run file's, then ONE
 *              transaction: guards (ids / names / alias keys free, activation rows unchanged) →
 *              products → activation UPDATE + inventory_logs → product_aliases → data_repair_runs
 *              (dry_run false, the before-state for rollback) → one audit_log row.
 *   --rollback removes this run's still-unreviewed aliases, the rows it created that nothing
 *              references, and restores the activated rows' is_active / price / stock where they
 *              still hold what the run set (dry run unless --apply).
 *
 * 🛑 MACEDONIA ONLY: scripts/assert-mk-target.mjs runs first; repair-kit's mkGuard() pins the ref
 * and refuses any config that mentions the live Bulgarian project.
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import {
  ROOT, MKD_PER_EUR, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, q, qUuid,
  candidateHash, canonicalJson, resolveActor, die, ok, warn, bold, yellow, green, fmtMkd, isUuid,
} from './lib/repair-kit.mjs';
import { classifyName, exactKey, stableUuid, cleanSpelling } from './lib/catalogue-match-mk.mjs';
import {
  planGroups, activeTwinOf, priceFor, samplesOf, windowStart, aliasSources, indexCatalogue,
  buildApplySql, buildRollbackSql, productValuesSql, activationValuesSql, aliasValuesSql, PRODUCT_REFERENCES,
} from './lib/complete-catalogue-mk.mjs';

const KEY = 'complete-catalogue';
const OUT_DIR = join(ROOT, 'exports', 'products');
const RUN_DIR = join(OUT_DIR, 'runs');
const CATEGORY = 'Од продажби — collabBox/web (28.09.2026)';
const ALTERCPA_CATEGORY = 'AlterCPA — нови понуди (28.09.2026)';   // created 28.09 — leave alone
const NOTE = 'AUTO complete-catalogue 28.09 — чека одобрување';
const HISTORY_FROM = '2022-01-01';
const ACTIVE_DAYS = 60;
const PRICE_DAYS = 90;
const PLACEHOLDER_STOCK = 1000;
const PLACEHOLDER_THRESHOLD = 5;

const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'rollback', 'explain', 'include-active'], values: ['run', 'actor'] });
const options = { includeActive: !!args['include-active'] };
const isDry = !args.apply && !args.explain && !args.rollback;

// ─── guards ─────────────────────────────────────────────────────────────────
console.log(bold(`\n=== ${KEY} ${args.rollback ? `(ROLLBACK${args.apply ? ' — APPLYING)' : ' — dry run)'}` : args.apply ? '(APPLYING)' : args.explain ? '(EXPLAIN — read-only)' : '(DRY RUN — read-only)'} ===`));
try {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { cwd: ROOT, stdio: 'inherit' });
} catch { die('scripts/assert-mk-target.mjs failed — refusing.'); }
mkGuard();
await assertRemoteIsMk();
mkdirSync(RUN_DIR, { recursive: true });

if (args.rollback) { await rollback(); process.exit(0); }

// ─── the instant the plan is taken at ───────────────────────────────────────
let rec = null;
if (!isDry) {
  if (!args.run || !isUuid(args.run)) die('--apply / --explain need --run <id> printed by a dry run.');
  const recFile = join(RUN_DIR, `${args.run}.json`);
  if (!existsSync(recFile)) die(`no run file ${recFile}`);
  rec = JSON.parse(readFileSync(recFile, 'utf8'));
  if (rec.key !== KEY) die(`run ${args.run} is not a ${KEY} run.`);
  if (canonicalJson(rec.options) !== canonicalJson(options)) die(`run ${args.run} was dry-run with options ${canonicalJson(rec.options)} — pass the same flags.`);
}
const asOf = rec ? rec.as_of : new Date().toISOString();
const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(asOf));
const since60 = windowStart(today, ACTIVE_DAYS);
const since90 = windowStart(today, PRICE_DAYS);
ok(`as of ${asOf} (Skopje day ${today}) · last ${ACTIVE_DAYS} days from ${since60} · price window from ${since90}`);

// ─── load (read-only) ───────────────────────────────────────────────────────
const [schema] = await sqlRead(`select to_regclass('public.product_aliases') is not null as aliases,
  to_regprocedure('public.insights_sale_rows(timestamptz,timestamptz,boolean)') is not null as rows_fn,
  to_regprocedure('public.product_alias_norm(text)') is not null as norm_fn,
  to_regclass('public.data_repair_runs') is not null as runs,
  to_regclass('public.inventory_logs') is not null as inv`);
if (!schema?.aliases || !schema.rows_fn || !schema.norm_fn || !schema.runs || !schema.inv) die('insights foundation / repair ledger / inventory_logs missing on the remote.');

const catalogue = await sqlRead(`select id, name, sku, barcode, is_active, coalesce(category, '') as category,
  price::float8 as price, price::text as price_text, cost_price::float8 as cost_price, stock_quantity, low_stock_threshold
  from public.products order by name, id`);
const existingAliases = await sqlRead(`select source, alias_norm, product_id, kind, reviewed_by is not null as reviewed from public.product_aliases`);
const cbMapFile = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json'), 'utf8'));

/**
 * The Sales tab's line set for one window (20260942000500 `ln0` … `lv`), with the line's product
 * resolved exactly as product_key() / order_line_kind() do (its product_id, else the alias of
 * its own source, else 'any').
 */
const linesSql = (from, toEnd) => `
WITH
rt AS MATERIALIZED (
  SELECT row_number() OVER () AS rid, s.kind, s.sale_source, s.value_mkd, s.order_id, s.web_id, s.display_id, s.sale_day
  FROM public.insights_sale_rows(${q(`${from} 00:00:00 Europe/Skopje`)}::timestamptz, ${toEnd}, false) s
  WHERE s.in_total
),
ln0 AS MATERIALIZED (
  SELECT rt.rid, rt.sale_source, rt.value_mkd, rt.sale_day, rt.display_id AS ref, oi.id::text AS lid,
         CASE WHEN rt.sale_source = 'collabbox' THEN 'collabbox' ELSE 'crm' END AS src,
         oi.product_id AS pid, oi.product_name AS name,
         greatest(coalesce(oi.quantity, 0), 0) AS qty,
         greatest(coalesce(oi.total_price, 0), 0)::numeric AS w, NULL::text AS shop_kind
  FROM rt JOIN public.order_items oi ON oi.order_id = rt.order_id
  WHERE rt.kind = 'order'
  UNION ALL
  SELECT rt.rid, NULL, rt.value_mkd, rt.sale_day, coalesce(wo.order_number, rt.web_id::text), 'w' || i.shop_item_id::text,
         'web', NULL::uuid, i.name,
         greatest(coalesce(i.quantity, 0), 0),
         greatest(coalesce(i.price, 0) * coalesce(i.quantity, 0) - coalesce(i.discount_allocated, 0), 0)::numeric, i.kind
  FROM rt JOIN public.web_order_items i ON i.shop_order_id = rt.web_id
  LEFT JOIN public.web_orders wo ON wo.shop_order_id = rt.web_id
  WHERE rt.kind = 'web'
),
dn AS MATERIALIZED (SELECT DISTINCT l.src, coalesce(public.product_alias_norm(l.name), '') AS norm FROM ln0 l),
am AS MATERIALIZED (
  SELECT dn.src, dn.norm,
    (SELECT a.product_id FROM public.product_aliases a WHERE a.source IN (dn.src, 'any') AND a.alias_norm = dn.norm
        AND a.product_id IS NOT NULL ORDER BY (a.source = dn.src) DESC LIMIT 1) AS apid,
    coalesce((SELECT a.kind FROM public.product_aliases a WHERE a.source IN (dn.src, 'any') AND a.alias_norm = dn.norm
        ORDER BY (a.source = dn.src) DESC LIMIT 1), 'product') AS akind
  FROM dn
),
ln1 AS MATERIALIZED (
  SELECT l.*, am.norm, coalesce(l.pid, am.apid) AS rpid,
         CASE WHEN am.akind IS DISTINCT FROM 'product' THEN am.akind
              WHEN l.shop_kind = 'GIFT' THEN 'gift'
              WHEN lower(coalesce(l.name, '')) ~ '^\\s*(поен|poen)(и|i)?([^[:alpha:]]|$)' THEN 'loyalty_point'
              WHEN lower(coalesce(l.name, '')) ~ '^\\s*(достава|dostava|delivery|shipping)([^[:alpha:]]|$)' THEN 'delivery'
              ELSE 'product' END AS kind0
  FROM ln0 l JOIN am ON am.src = l.src AND am.norm = coalesce(public.product_alias_norm(l.name), '')
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
  FROM (SELECT l.rid, l.lid, l.src, l.rpid, l.pid, l.name, l.norm, l.qty, l.sale_day, l.ref,
               CASE WHEN l.kind0 = 'product' AND l.w = 0 AND l.sw > 0 THEN 'gift' ELSE l.kind0 END AS lkind,
               CASE WHEN l.sw > 0 THEN round(l.value_mkd * l.cw / l.sw) - round(l.value_mkd * (l.cw - l.w) / l.sw)
                    WHEN l.sq > 0 THEN round(l.value_mkd * l.cq / l.sq) - round(l.value_mkd * (l.cq - l.pq) / l.sq)
                    ELSE 0::numeric END AS val
        FROM ln2 l) z
),
samp AS (
  SELECT x.rpid, x.sale_day, round(x.val / x.qty, 4) AS u,
         row_number() OVER (PARTITION BY x.rpid ORDER BY x.sale_day DESC, x.val / x.qty, x.lid) AS rn
  FROM lv x
  WHERE x.rpid IS NOT NULL AND x.lkind = 'product' AND NOT x.bad_qty AND x.qty >= 1 AND x.val > 0
)
SELECT
  (SELECT coalesce(jsonb_agg(m), '[]') FROM (
     SELECT to_char(lv.sale_day, 'YYYY-MM') AS mon,
            coalesce(sum(lv.val) FILTER (WHERE lv.lkind = 'product'), 0)::float8 AS v,
            coalesce(sum(lv.val) FILTER (WHERE lv.lkind = 'product' AND lv.rpid IS NOT NULL), 0)::float8 AS res
     FROM lv GROUP BY 1) m) AS monthly,
  (SELECT coalesce(jsonb_agg(u), '[]') FROM (
     SELECT lv.src, lv.name, lv.norm, lv.lkind, lv.qty, lv.val::float8 AS val, lv.bad_qty, lv.sale_day::text AS d, lv.ref
     FROM lv WHERE lv.rpid IS NULL AND lv.lkind IN ('product', 'gift')) u) AS unresolved,
  (SELECT coalesce(jsonb_agg(p), '[]') FROM (
     SELECT lv.rpid AS pid, count(*)::int AS lines, sum(CASE WHEN lv.bad_qty THEN 0 ELSE lv.qty END)::int AS units,
            sum(lv.val)::float8 AS v, min(lv.sale_day)::text AS d_min, max(lv.sale_day)::text AS d_max
     FROM lv WHERE lv.rpid IS NOT NULL AND lv.lkind = 'product' GROUP BY 1) p) AS byproduct,
  (SELECT coalesce(jsonb_agg(jsonb_build_array(s.rpid, s.sale_day::text, s.u::float8)), '[]')
     FROM samp s WHERE s.rn <= 20 OR s.sale_day >= ${q(since90)}::date) AS samples`;

function windows() {
  const out = [];
  const end = new Date(asOf);
  let d = new Date(`${HISTORY_FROM}T00:00:00Z`);
  while (d < end) {
    const n = new Date(d); n.setUTCMonth(n.getUTCMonth() + 6);
    const from = d.toISOString().slice(0, 10);
    const last = n >= end;
    out.push([from, last ? `${q(asOf)}::timestamptz` : `${q(`${n.toISOString().slice(0, 10)} 00:00:00 Europe/Skopje`)}::timestamptz - interval '1 microsecond'`]);
    d = n;
  }
  return out;
}

const monthly = new Map();
const unresolved = [];
const usage = new Map();      // product id → { v, lines, units, dMin, dMax }
const samples = new Map();    // product id → [{ d, u }]
for (const [from, toEnd] of windows()) {
  const [r] = await sqlRead(linesSql(from, toEnd));
  for (const m of r.monthly || []) {
    const x = monthly.get(m.mon) || { v: 0, res: 0 };
    x.v += Number(m.v); x.res += Number(m.res); monthly.set(m.mon, x);
  }
  unresolved.push(...(r.unresolved || []));
  for (const b of r.byproduct || []) {
    const u = usage.get(b.pid) || { v: 0, lines: 0, units: 0, dMin: null, dMax: null };
    u.v += Number(b.v); u.lines += b.lines; u.units += b.units;
    if (!u.dMin || b.d_min < u.dMin) u.dMin = b.d_min;
    if (!u.dMax || b.d_max > u.dMax) u.dMax = b.d_max;
    usage.set(b.pid, u);
  }
  for (const [pid, d, u] of r.samples || []) {
    if (!samples.has(pid)) samples.set(pid, []);
    samples.get(pid).push({ d, u: Number(u) });
  }
}
ok(`sale lines loaded: ${unresolved.length} lines with no catalogue product · ${usage.size} catalogue products with sales (${HISTORY_FROM} → ${asOf})`);

// ─── classification (the import script's classifier gives services, bundles, identity doubts) ──
const bySku = new Map(catalogue.map((p) => [String(p.sku), p]));
const byExact = new Map();
for (const p of catalogue) { const k = exactKey(p.name); if (!byExact.has(k)) byExact.set(k, []); byExact.get(k).push(p); }
const cbMap = new Map(cbMapFile.matched.map((e) => [String(e.collabbox_name).trim().replace(/\s+/g, ' ').toLowerCase(), e]));
const pickAmong = (ps) => [...ps].sort((a, b) => (usage.get(b.id)?.v || 0) - (usage.get(a.id)?.v || 0)
  || (b.is_active - a.is_active) || (String(a.sku) < String(b.sku) ? -1 : String(a.sku) > String(b.sku) ? 1 : 0))[0];

const variantsByKey = new Map();
const srcsByNorm = new Map();
for (const l of unresolved) {
  if (l.norm === null || l.norm === '') continue;
  const k = `${l.src}\u0001${l.norm}`;
  if (!variantsByKey.has(k)) variantsByKey.set(k, { src: l.src, norm: l.norm, spellings: new Map(), lines: [] });
  const v = variantsByKey.get(k);
  v.spellings.set(l.name, (v.spellings.get(l.name) || 0) + 1);
  v.lines.push(l);
  if (!srcsByNorm.has(l.norm)) srcsByNorm.set(l.norm, new Set());
  srcsByNorm.get(l.norm).add(l.src);
}
const variants = [...variantsByKey.values()].sort((a, b) => (a.src + a.norm < b.src + b.norm ? -1 : 1));
for (const v of variants) {
  const top = [...v.spellings.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
  try { v.classification = classifyName(top, { bySku, byExact, cbMap, sources: srcsByNorm.get(v.norm), pickAmong }); } catch { v.classification = null; }
}

const { groups } = planGroups(variants, catalogue, { pickAmong, today, activeDays: ACTIVE_DAYS, priceDays: PRICE_DAYS });
const decided = (d) => groups.filter((g) => g.decision === d).sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));
const links = decided('link');
const creates = decided('create');
const unsure = decided('unsure');
const excluded = decided('exclude');

// ─── 2. CREATE: the new rows ────────────────────────────────────────────────
const catalogueNames = new Map(catalogue.map((p) => [cleanSpelling(p.name).toLowerCase(), p]));
const newProducts = [];
for (const g of creates) {
  const clash = catalogueNames.get(String(g.name).toLowerCase());
  if (clash) {   // the catalogue already has that exact name — it is that row
    g.decision = 'link'; g.target = clash; g.why = `истото име веќе постои во каталогот („${clash.name}“)`;
    links.push(g);
    continue;
  }
  const active = g.soldRecently;
  const price = g.price?.eur ?? 0;
  newProducts.push({
    id: stableUuid(`complete-catalogue:${g.key}`, createHash), key: g.key, name: g.name, category: CATEGORY,
    price, price_basis: g.price?.basis ?? 'none', price_n: g.price?.n ?? 0,
    is_active: active, stock: active ? PLACEHOLDER_STOCK : 0, threshold: active ? PLACEHOLDER_THRESHOLD : 0,
    bundle: !!g.bundle, group: g,
  });
}
const createdIds = new Set(newProducts.map((p) => p.id));
const creates2 = creates.filter((g) => g.decision === 'create');
links.sort((a, b) => b.value - a.value || (a.key < b.key ? -1 : 1));

// ─── aliases: every spelling of a linked / created group ────────────────────
const aliasTaken = new Map(existingAliases.map((a) => [`${a.source}\u0001${a.alias_norm}`, a]));
const takenForNorm = (norm) => existingAliases.filter((a) => a.alias_norm === norm);
const aliasRows = [];
const aliasConflicts = [];
function planAliases(g, productId, label) {
  const bySrc = new Map();
  for (const v of g.variants) {
    if (!bySrc.has(v.norm)) bySrc.set(v.norm, new Set());
    bySrc.get(v.norm).add(v.src);
  }
  for (const [norm, srcs] of [...bySrc.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // 'any' (it survives the department reclass), unless the spelling already has an alias row
    const sources = aliasSources([...srcs], takenForNorm(norm).length > 0);
    for (const source of sources) {
      const taken = aliasTaken.get(`${source}\u0001${norm}`) || aliasTaken.get(`any\u0001${norm}`);
      if (taken) { aliasConflicts.push({ source, norm, existing: taken, planned: productId }); continue; }
      aliasRows.push({ source, alias_norm: norm, product_id: productId, kind: 'product', decision: label });
    }
  }
}
for (const g of links) planAliases(g, g.target.id, 'постоечки');
for (const p of newProducts) planAliases(p.group, p.id, 'нов');
const aliasIndex = new Map(aliasRows.map((r) => [`${r.source}\u0001${r.alias_norm}`, r]));
const resolvedBy = (src, norm) => aliasIndex.get(`${src}\u0001${norm}`) || aliasIndex.get(`any\u0001${norm}`) || null;

// ─── 1. ACTIVATE (after the new links: a link can make a row "sold in the last 60 days") ──
const lastSold = new Map([...usage.entries()].map(([id, u]) => [id, u.dMax]));
const extraSamples = new Map();
for (const g of links) {
  const pid = g.target.id;
  if (g.lastSold && (!lastSold.get(pid) || g.lastSold > lastSold.get(pid))) lastSold.set(pid, g.lastSold);
  if (!extraSamples.has(pid)) extraSamples.set(pid, []);
  extraSamples.get(pid).push(...samplesOf(g.lines));
}
const linkedIds = new Set(links.filter((g) => g.soldRecently).map((g) => g.target.id));
const catIndex = indexCatalogue(catalogue);
const activations = [];
const twins = [];
const activeGaps = [];
for (const p of catalogue) {
  if (p.category === ALTERCPA_CATEGORY) continue;
  const last = lastSold.get(p.id);
  if (!last || last < since60) continue;
  const gapPrice = !(Number(p.price) > 0);
  const gapStock = !(Number(p.stock_quantity) > 0);
  if (p.is_active && !gapPrice && !gapStock) continue;
  if (!p.is_active) {
    const twin = activeTwinOf(p, catalogue, catIndex);
    if (twin) { twins.push({ p, twin, last }); continue; }
  } else if (!options.includeActive) {
    activeGaps.push({ p, last, gapPrice, gapStock });
    continue;
  }
  const pr = gapPrice ? priceFor([...(samples.get(p.id) || []), ...(extraSamples.get(p.id) || [])], { today, priceDays: PRICE_DAYS }) : null;
  activations.push({
    id: p.id, sku: p.sku, name: p.name, category: p.category, last, via_link: linkedIds.has(p.id),
    mode: p.is_active ? 'fill' : 'activate', price_text: p.price_text,
    before: { is_active: p.is_active, price: Number(p.price), stock: Number(p.stock_quantity), threshold: Number(p.low_stock_threshold) },
    after: {
      is_active: true,
      price: gapPrice && pr?.eur ? pr.eur : Number(p.price),
      stock: gapStock ? PLACEHOLDER_STOCK : Number(p.stock_quantity),
      threshold: gapStock ? PLACEHOLDER_THRESHOLD : Number(p.low_stock_threshold),
    },
    price_basis: pr?.basis ?? null, price_n: pr?.n ?? null, no_price: gapPrice && !pr?.eur,
  });
}
activations.sort((a, b) => (a.name < b.name ? -1 : 1));

// ─── the plan + its hash ────────────────────────────────────────────────────
const lines = [
  ...newProducts.map((p) => `product:${p.id}|${p.name}|${p.price}|${p.is_active}|${p.stock}|${p.threshold}|${p.category}`),
  ...activations.map((a) => `activate:${a.id}|${a.mode}|${canonicalJson(a.before)}|${canonicalJson(a.after)}`),
  ...aliasRows.map((r) => `alias:${r.source}|${r.alias_norm}|${r.product_id}`),
];
const hash = candidateHash(lines);

// ─── before / after: the share of PRODUCT value that resolves to a catalogue product ──
function share(monthFilter) {
  let v = 0; let res = 0; let add = 0;
  for (const [mon, x] of monthly) if (monthFilter(mon)) { v += x.v; res += x.res; }
  for (const l of unresolved) {
    if (l.lkind !== 'product' || !monthFilter(l.d.slice(0, 7))) continue;
    if (resolvedBy(l.src, l.norm)) add += Number(l.val);
  }
  const pct = (n) => (v ? (100 * n) / v : 0);
  return { value_mkd: Math.round(v), before_pct: pct(res), after_pct: pct(res + add),
    before_unresolved_mkd: Math.round(v - res), after_unresolved_mkd: Math.round(v - res - add) };
}
const shares = { all: share(() => true), y2026: share((m) => m >= '2026-01'), sep2026: share((m) => m === '2026-09') };

// ─── summary ────────────────────────────────────────────────────────────────
const pctS = (x) => `${x.toFixed(1).replace('.', ',')} %`;
const sumV = (gs) => Math.round(gs.reduce((s, g) => s + g.value, 0));
const summary = {
  as_of: asOf, today, options,
  activate: {
    rows: activations.length, activated: activations.filter((a) => a.mode === 'activate').length,
    filled_active: activations.filter((a) => a.mode === 'fill').length,
    price_set: activations.filter((a) => a.after.price !== a.before.price).length,
    stock_set: activations.filter((a) => a.after.stock !== a.before.stock).length,
    via_new_link: activations.filter((a) => a.via_link).length,
    no_price_found: activations.filter((a) => a.no_price).length,
    twins_skipped: twins.length,
    active_with_gaps_listed: activeGaps.length,
    active_gaps_price0: activeGaps.filter((x) => x.gapPrice).length,
    active_gaps_stock0: activeGaps.filter((x) => x.gapStock).length,
  },
  create: {
    products: newProducts.length, active: newProducts.filter((p) => p.is_active).length,
    history_only: newProducts.filter((p) => !p.is_active).length, bundles: newProducts.filter((p) => p.bundle).length,
    value_mkd: sumV(creates2), spellings: creates2.reduce((s, g) => s + g.variants.length, 0),
  },
  link: { groups: links.length, products: new Set(links.map((g) => g.target.id)).size, value_mkd: sumV(links), spellings: links.reduce((s, g) => s + g.variants.length, 0) },
  unsure: { groups: unsure.length, value_mkd: sumV(unsure) },
  exclude: { groups: excluded.length, value_mkd: sumV(excluded) },
  aliases: { rows: aliasRows.length, any: aliasRows.filter((r) => r.source === 'any').length, conflicts: aliasConflicts.length },
  shares, lines: lines.length,
};

// ─── outputs (dry run only) ─────────────────────────────────────────────────
const runId = isDry ? randomUUID() : args.run;
const stamp = today;
const fmtD = (iso) => (iso ? `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}` : '');
const mkd = (eur) => Math.round(Number(eur || 0) * MKD_PER_EUR);
const spellingsOf = (g) => {
  const m = new Map();
  for (const v of g.variants) for (const [s, n] of v.spellings) m.set(cleanSpelling(s), (m.get(cleanSpelling(s)) || 0) + n);
  return [...m.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
};
const srcLabel = { crm: 'CRM', collabbox: 'collabBox', web: 'веб' };
const sourcesOf = (g) => [...new Set(g.variants.map((v) => srcLabel[v.src] || v.src))].join(', ');
const groupRow = (g) => ({
  key: g.key, value_mkd: Math.round(g.value), first: g.firstSold, last: g.lastSold, sold_last_60d: g.soldRecently,
  sources: sourcesOf(g), why: g.why, spellings: spellingsOf(g).map(([s, n]) => ({ name: s, lines: n })),
});
const planJson = {
  generated: new Date().toISOString(), run_id: runId, key: KEY, hash, summary,
  activate: activations, twins_not_activated: twins.map((t) => ({ id: t.p.id, sku: t.p.sku, name: t.p.name, last: t.last, active_twin: { id: t.twin.id, sku: t.twin.sku, name: t.twin.name } })),
  active_gaps: activeGaps.map((x) => ({ id: x.p.id, sku: x.p.sku, name: x.p.name, price: x.p.price, stock: x.p.stock_quantity, last: x.last })),
  create: newProducts.map((p) => ({ id: p.id, name: p.name, price_eur: p.price, price_mkd: mkd(p.price), price_basis: p.price_basis, price_n: p.price_n,
    is_active: p.is_active, stock: p.stock, low_stock_threshold: p.threshold, bundle: p.bundle, category: p.category,
    similar_in_catalogue: (p.group.similar || []).map((x) => `${x.name} [${x.sku}]`), ...groupRow(p.group) })),
  link: links.map((g) => ({ target: { id: g.target.id, sku: g.target.sku, name: g.target.name, is_active: g.target.is_active }, ...groupRow(g) })),
  unsure: unsure.map((g) => ({ candidates: (g.candidates || []).map((p) => `${p.name} [${p.sku}]`), suggest: g.suggest || null, ...groupRow(g) })),
  exclude: excluded.map(groupRow),
  aliases: aliasRows, alias_conflicts: aliasConflicts,
};
const suffix = options.includeActive ? '-include-active' : '';   // the two variants never overwrite each other
const planFile = join(OUT_DIR, `${stamp}-complete-plan${suffix}.json`);
const xlsxFile = join(OUT_DIR, `${stamp}-complete-plan${suffix}.xlsx`);
const csvFile = join(OUT_DIR, `${stamp}-complete-plan${suffix}.csv`);
const runFile = join(RUN_DIR, `${runId}.json`);
if (isDry) {
  writeFileSync(planFile, JSON.stringify(planJson, null, 1));
  writeFileSync(runFile, JSON.stringify({ id: runId, key: KEY, created_at: new Date().toISOString(), as_of: asOf, today, hash, options, summary,
    plan: { products: newProducts.map(({ group, ...p }) => p), activations, aliases: aliasRows } }, null, 1));
  writeOwnerFiles();
}

// ─── report ─────────────────────────────────────────────────────────────────
const A = summary.activate;
console.log(`\n${bold('1. ACTIVATE')} (sold since ${since60}, inactive): ${A.activated} rows → active${options.includeActive ? ` · + ${A.filled_active} active rows filled` : ''} · price set on ${A.price_set} · stock 0→${PLACEHOLDER_STOCK} on ${A.stock_set}${A.via_new_link ? ` · ${A.via_new_link} sold only through a new alias` : ''}${A.no_price_found ? ` · ${A.no_price_found} without a priced line (price stays 0)` : ''}`);
console.log(`   not activated — an active twin sells it: ${A.twins_skipped}${twins.length ? ` (${twins.map((t) => `${t.p.name} = ${t.twin.name}`).join('; ')})` : ''}`);
if (!options.includeActive) console.log(`   ${yellow(`listed only: ${A.active_with_gaps_listed} ACTIVE rows sold in the last ${ACTIVE_DAYS} days with price 0 (${A.active_gaps_price0}) or stock ≤ 0 (${A.active_gaps_stock0}) — --include-active fills them the same way`)}`);
const C = summary.create;
console.log(`${bold('2. CREATE')}: ${C.products} new products (${C.active} active — sold in the last ${ACTIVE_DAYS} days, stock ${PLACEHOLDER_STOCK} · ${C.history_only} history only, inactive · ${C.bundles} are sets / combos) from ${C.spellings} spellings · ${fmtMkd(C.value_mkd)} ден`);
console.log(`   linked to EXISTING rows instead: ${summary.link.groups} groups → ${summary.link.products} products · ${summary.link.spellings} spellings · ${fmtMkd(summary.link.value_mkd)} ден`);
console.log(`   unsure (NOT created, listed): ${summary.unsure.groups} groups · ${fmtMkd(summary.unsure.value_mkd)} ден   excluded non-products: ${summary.exclude.groups} · ${fmtMkd(summary.exclude.value_mkd)} ден`);
console.log(`   product_aliases: ${summary.aliases.rows} rows (${summary.aliases.any} source 'any')${aliasConflicts.length ? yellow(` · ${aliasConflicts.length} names already have an alias row — left alone`) : ''}`);
console.log(`${bold('Product value resolving to a catalogue product')}:`);
for (const [label, s] of [['all history   ', shares.all], ['2026          ', shares.y2026], ['September 2026', shares.sep2026]]) {
  console.log(`  ${label} ${pctS(s.before_pct)} → ${green(pctS(s.after_pct))}   (unresolved ${fmtMkd(s.before_unresolved_mkd)} → ${fmtMkd(s.after_unresolved_mkd)} ден of ${fmtMkd(s.value_mkd)})`);
}
console.log(`\n${bold('Top 40 new products by value')} (name · € · active · value ден · spellings):`);
for (const p of newProducts.slice(0, 40)) {
  const sp = spellingsOf(p.group);
  console.log(`  ${String(fmtMkd(Math.round(p.group.value))).padStart(10)}  ${p.is_active ? green('A') : '-'}  €${String(p.price).padEnd(7)} ${p.name}`);
  if (sp.length > 1) console.log(`${' '.repeat(26)}↳ ${sp.slice(0, 6).map(([s, n]) => `${s} (${n})`).join(' | ')}${sp.length > 6 ? ` | … +${sp.length - 6}` : ''}`);
}
if (unsure.length) {
  console.log(`\n${bold('Unsure — not created')}:`);
  for (const g of unsure) console.log(`  ${String(fmtMkd(Math.round(g.value))).padStart(10)}  ${spellingsOf(g)[0][0]} — ${g.why}`);
}
console.log(isDry ? `\n  plan : ${planFile}\n  owner: ${xlsxFile}\n  csv  : ${csvFile}\n  run  : ${runFile}\n  hash : ${hash.slice(0, 16)}…` : `\n  hash : ${hash.slice(0, 16)}…`);

if (isDry) {
  console.log(`\n${bold('DRY RUN — nothing was written to the database.')}  Run id: ${bold(runId)}`);
  console.log(`  Preflight:  node scripts/complete-catalogue.mjs --explain --run ${runId}${options.includeActive ? ' --include-active' : ''}`);
  console.log(`  Apply (after the owner's review):  node scripts/complete-catalogue.mjs --apply --run ${runId}${options.includeActive ? ' --include-active' : ''}`);
  process.exit(0);
}

// ─── apply / explain ────────────────────────────────────────────────────────
if (rec.hash !== hash) die(`The plan changed since that dry run (hash ${hash.slice(0, 12)}… ≠ ${rec.hash.slice(0, 12)}…). Dry-run again, review, apply THAT id.`);
const [done] = await sqlRead(`select count(*)::int as n from public.data_repair_runs where key = ${q(KEY)} and summary->>'run_id' = ${q(args.run)}`);
if (done?.n) die(`run ${args.run} was already applied.`);
ok(`hash matches the dry run (${hash.slice(0, 12)}…)`);

const noteRun = (extra) => `${NOTE} · run ${args.run} · ${extra}`.slice(0, 1000);
const describe = (p) => {
  const g = p.group;
  return `Креиран автоматски (${KEY}, run ${args.run}): производ со продажби што го немаше во каталогот — ${g.variants.length} имиња, продаван ${fmtD(g.firstSold)}–${fmtD(g.lastSold)}, ${fmtMkd(Math.round(g.value))} ден. Цена = типична продажна цена (${p.price_basis === 'last90' ? `медијана, последни ${PRICE_DAYS} дена` : 'медијана, последните 20 продажби'}, n=${p.price_n}). Набавната цена ја внесува сопственикот.`;
};
const productRows = newProducts.map((p) => ({ id: p.id, name: p.name, description: describe(p), price: p.price, is_active: p.is_active, stock: p.stock, threshold: p.threshold, category: p.category }));
const aliasInsertRows = aliasRows.map((r) => ({ ...r, note: noteRun(r.decision === 'нов' ? 'нов производ' : 'постоечки производ') }));
const productValues = productValuesSql(productRows);
const actValues = activationValuesSql(activations);
const aliasValues = aliasValuesSql(aliasInsertRows);

if (args.explain) {
  // READ-ONLY preflight: the exact VALUES lists through SELECTs that check what the apply would hit
  const newIds = newProducts.map((p) => qUuid(p.id));
  if (productValues.length) {
    const [p] = await sqlRead(`SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.products x WHERE x.id = v.id))::int AS id_exists,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.products x WHERE lower(btrim(x.name)) = lower(btrim(v.name))))::int AS name_exists,
        (SELECT count(*) FROM (SELECT lower(btrim(v2.name)) FROM (VALUES ${productValues.join(',\n')}) v2(id, name, description, price, active, stock, thr, category) GROUP BY 1 HAVING count(*) > 1) d)::int AS dup_names
      FROM (VALUES ${productValues.join(',\n')}) v(id, name, description, price, active, stock, thr, category)`);
    (p.id_exists + p.name_exists + p.dup_names ? warn : ok)(`products: ${p.rows} to insert · id already present ${p.id_exists} · name already present ${p.name_exists} · duplicate names ${p.dup_names}`);
  }
  if (actValues.length) {
    const [a] = await sqlRead(`SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE x.id IS NULL)::int AS missing,
        count(*) FILTER (WHERE x.is_active IS DISTINCT FROM v.act_before OR x.price IS DISTINCT FROM v.price_before OR x.stock_quantity IS DISTINCT FROM v.stock_before)::int AS drifted
      FROM (VALUES ${actValues.join(',\n')}) v(id, mode, act_before, price_before, stock_before, price_after, stock_after, thr_after)
      LEFT JOIN public.products x ON x.id = v.id`);
    (a.missing + a.drifted ? warn : ok)(`activations: ${a.rows} rows · missing ${a.missing} · changed since the dry run ${a.drifted}`);
  }
  if (aliasValues.length) {
    const [a] = await sqlRead(`SELECT count(*)::int AS rows,
        count(*) FILTER (WHERE v.source NOT IN ('crm','collabbox','web','altercpa','mex','any'))::int AS bad_source,
        count(*) FILTER (WHERE coalesce(v.alias_norm, '') = '' OR v.alias_norm IS DISTINCT FROM public.product_alias_norm(v.alias_norm))::int AS bad_norm,
        count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM public.products x WHERE x.id = v.product_id)
                           AND v.product_id <> ALL (${newIds.length ? `ARRAY[${newIds.join(',')}]` : 'ARRAY[]::uuid[]'}))::int AS dangling_fk,
        count(*) FILTER (WHERE EXISTS (SELECT 1 FROM public.product_aliases x WHERE x.alias_norm = v.alias_norm AND x.source IN (v.source, 'any')))::int AS already_there,
        (SELECT count(*) FROM (SELECT v2.source, v2.alias_norm FROM (VALUES ${aliasValues.join(',\n')}) v2(source, alias_norm, product_id, kind, note) GROUP BY 1, 2 HAVING count(*) > 1) d)::int AS dup_keys
      FROM (VALUES ${aliasValues.join(',\n')}) v(source, alias_norm, product_id, kind, note)`);
    const bad = a.bad_source + a.bad_norm + a.dangling_fk + a.already_there + a.dup_keys;
    (bad ? warn : ok)(`product_aliases: ${a.rows} rows · bad source ${a.bad_source} · key ≠ product_alias_norm ${a.bad_norm} · dangling product_id ${a.dangling_fk} · key already present ${a.already_there} · duplicate keys ${a.dup_keys}`);
  }
  process.exit(0);
}

const actor = await resolveActor(args.actor || 'mile@elyon.com');
const before = activations.map((a) => ({ id: a.id, mode: a.mode, before: a.before, after: a.after, price_text: a.price_text }));
const applySql = buildApplySql({
  key: KEY, runId: args.run, hash, products: productRows, activations, aliases: aliasInsertRows,
  actorId: actor.id, actorEmail: actor.email,
  runSummary: { ...summary, run_id: args.run, before },
  auditPayload: { run_id: args.run, hash, as_of: asOf, options, created: newProducts.length, activated: activations.length, aliases: aliasRows.length, shares },
  invNote: `complete-catalogue run ${args.run}: залиха-placeholder ${PLACEHOLDER_STOCK} (до пописот на сопственикот)`,
});
const [res] = await sql(applySql);
ok(`applied as ${actor.email} in one transaction: ${res?.products ?? '?'} new products, ${res?.active_now ?? '?'}/${activations.length} activation rows active, ${res?.aliases ?? '?'} alias rows`);
console.log(yellow('  The aliases count in every insights report now; reviewed_by stays NULL until the owner approves.'));
process.exit(0);

// ─── owner files ────────────────────────────────────────────────────────────
function writeOwnerFiles() {
  const wb = XLSX.utils.book_new();
  const sheet = (name, rows, widths) => {
    const ws = XLSX.utils.json_to_sheet(rows.length ? rows : [{ '—': 'нема' }]);
    ws['!cols'] = (widths || []).map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const S = summary;
  sheet('Преглед', [
    ['Run id', runId], ['Податоци заклучно со', `${asOf} (ден ${fmtD(today)})`], ['Хаш', hash.slice(0, 16)],
    ['1. Активирани производи (продавани во последните 60 дена, неактивни)', S.activate.activated],
    ['   од нив: поставена цена (беше 0)', S.activate.price_set], ['   од нив: поставена залиха 1000 (беше 0)', S.activate.stock_set],
    ['   НЕ се активираат — ист активен производ веќе постои', S.activate.twins_skipped],
    ['   Активни, но без залиха/цена (само список; --include-active ги пополнува)', S.activate.active_with_gaps_listed],
    ['2. Нови производи (вкупно)', S.create.products], ['   активни (продавани во последните 60 дена, залиха 1000)', S.create.active],
    ['   само историја (неактивни, залиха 0)', S.create.history_only], ['   од нив сетови / комбинации', S.create.bundles],
    ['   вредност на продажбите, ден', S.create.value_mkd],
    ['Поврзани со ПОСТОЕЧКИ производ (без нов ред)', `${S.link.groups} групи → ${S.link.products} производи, ${fmtMkd(S.link.value_mkd)} ден`],
    ['Несигурни — НЕ се креираат (одлука на сопственикот)', `${S.unsure.groups} групи, ${fmtMkd(S.unsure.value_mkd)} ден`],
    ['Исклучени (не се производи)', `${S.exclude.groups} групи, ${fmtMkd(S.exclude.value_mkd)} ден`],
    ['Алијаси (product_aliases) што ќе се запишат', S.aliases.rows],
    ['Вредност на производите што се препознаени — цела историја', `${pctS(S.shares.all.before_pct)} → ${pctS(S.shares.all.after_pct)}`],
    ['— 2026', `${pctS(S.shares.y2026.before_pct)} → ${pctS(S.shares.y2026.after_pct)}`],
    ['— септември 2026', `${pctS(S.shares.sep2026.before_pct)} → ${pctS(S.shares.sep2026.after_pct)}`],
    ['Цена', `типична продажна цена: медијана на денари по единица во последните ${PRICE_DAYS} дена ÷ 61,5; ако има помалку од 3 продажби — медијана на последните 20 продажби. Набавна цена: не се менува / 0.`],
    ['Алијасите', `${NOTE} — reviewed_by празно; важат во извештаите веднаш по примената.`],
  ].map(([a, b]) => ({ Ставка: a, Вредност: b })), [70, 90]);
  sheet('1 Активирај', [
    ...activations.map((a) => ({
      Акција: a.mode === 'activate' ? 'активирај' : 'пополни (активен)', SKU: a.sku, Производ: a.name, Категорија: a.category,
      'Последна продажба': fmtD(a.last), 'Преку нов алијас': a.via_link ? 'да' : '',
      'Цена € пред': a.before.price, 'Цена € после': a.after.price, 'Цена ден после': mkd(a.after.price),
      'Основа на цената': a.price_basis === 'last90' ? `последни ${PRICE_DAYS} дена` : a.price_basis === 'recent20' ? 'последни 20 продажби' : a.no_price ? 'нема продажба со цена — останува 0' : '(цената не се менува)',
      'Продажби во основата': a.price_n ?? '', 'Залиха пред': a.before.stock, 'Залиха после': a.after.stock, 'Праг после': a.after.threshold,
    })),
    ...twins.map((t) => ({ Акција: 'НЕ — активен близнак', SKU: t.p.sku, Производ: t.p.name, Категорија: t.p.category, 'Последна продажба': fmtD(t.last),
      'Основа на цената': `истиот производ веќе се продава како „${t.twin.name}“ [${t.twin.sku}]` })),
    ...activeGaps.map((x) => ({ Акција: 'активен без цена/залиха (само список)', SKU: x.p.sku, Производ: x.p.name, Категорија: x.p.category,
      'Последна продажба': fmtD(x.last), 'Цена € пред': x.p.price, 'Залиха пред': x.p.stock_quantity })),
  ], [26, 12, 42, 22, 12, 8, 10, 10, 10, 34, 8, 8, 8, 8]);
  sheet('2 Нови производи', newProducts.map((p) => {
    const g = p.group; const sp = spellingsOf(g);
    return {
      Име: p.name, Активен: p.is_active ? 'да' : 'не', 'Цена €': p.price, 'Цена ден': mkd(p.price),
      'Основа на цената': p.price_basis === 'last90' ? `последни ${PRICE_DAYS} дена` : 'последни 20 продажби', 'Продажби во основата': p.price_n,
      Залиха: p.stock, 'Вид': p.bundle ? 'сет / комбинација' : 'производ', 'Вредност ден (сите години)': Math.round(g.value),
      'Прва продажба': fmtD(g.firstSold), 'Последна продажба': fmtD(g.lastSold), Извори: sourcesOf(g),
      'Број имиња': sp.length, 'Имиња (линии)': sp.map(([s, n]) => `${s} (${n})`).join(' | '),
      'Слично во каталогот': (g.similar || []).map((x) => `${x.name} [${x.sku}]`).join(' | '), id: p.id, клуч: p.key,
    };
  }), [48, 8, 8, 9, 18, 8, 7, 16, 12, 11, 11, 16, 8, 80, 50, 38, 40]);
  sheet('3 Поврзани (постоечки)', links.map((g) => {
    const sp = spellingsOf(g);
    return { 'Постоечки производ': g.target.name, SKU: g.target.sku, 'Активен сега': g.target.is_active ? 'да' : 'не', Зошто: g.why,
      'Вредност ден': Math.round(g.value), 'Последна продажба': fmtD(g.lastSold), Извори: sourcesOf(g),
      'Имиња (линии)': sp.map(([s, n]) => `${s} (${n})`).join(' | '), клуч: g.key };
  }), [42, 12, 8, 60, 12, 11, 16, 80, 30]);
  sheet('4 Несигурни (НЕ)', unsure.map((g) => {
    const sp = spellingsOf(g);
    return { 'Главно име': sp[0][0], Зошто: g.why, Кандидати: [...(g.candidates || []).map((p) => `${p.name} [${p.sku}]`), g.suggest].filter(Boolean).join(' | '),
      'Вредност ден': Math.round(g.value), 'Последна продажба': fmtD(g.lastSold), 'Продаван во последните 60 дена': g.soldRecently ? 'да' : 'не',
      'Имиња (линии)': sp.map(([s, n]) => `${s} (${n})`).join(' | '), клуч: g.key };
  }), [40, 60, 60, 12, 11, 10, 80, 30]);
  sheet('5 Исклучени', excluded.map((g) => {
    const sp = spellingsOf(g);
    return { 'Главно име': sp[0][0], Зошто: g.why, 'Вредност ден': Math.round(g.value), 'Имиња (линии)': sp.map(([s, n]) => `${s} (${n})`).join(' | ') };
  }), [40, 60, 12, 80]);
  const nameOf = new Map([...newProducts.map((p) => [p.id, `${p.name} (НОВ)`]), ...catalogue.map((p) => [p.id, `${p.name} [${p.sku}]`])]);
  sheet('6 Алијаси', aliasRows.map((r) => ({ source: r.source, alias_norm: r.alias_norm, Производ: nameOf.get(r.product_id) || r.product_id, Вид: r.decision })), [10, 60, 60, 10]);
  XLSX.writeFile(wb, xlsxFile, { compression: true });

  const cols = ['Одлука', 'Име', 'Производ во каталогот', 'SKU', 'Активен', 'Цена €', 'Вредност ден', 'Прва', 'Последна', 'Имиња', 'Зошто'];
  const rows = [
    ...activations.map((a) => [a.mode === 'activate' ? 'активирај' : 'пополни', a.name, a.name, a.sku, 'да', a.after.price, '', '', fmtD(a.last), '', a.via_link ? 'продаван преку нов алијас' : '']),
    ...twins.map((t) => ['не активирај (близнак)', t.p.name, t.twin.name, t.twin.sku, 'да', '', '', '', fmtD(t.last), '', 'истиот производ веќе е активен']),
    ...newProducts.map((p) => ['нов', p.name, p.name, '(нов)', p.is_active ? 'да' : 'не', p.price, Math.round(p.group.value), fmtD(p.group.firstSold), fmtD(p.group.lastSold), spellingsOf(p.group).map(([s]) => s).join(' | '), p.group.why]),
    ...links.map((g) => ['поврзи', spellingsOf(g)[0][0], g.target.name, g.target.sku, g.target.is_active ? 'да' : 'не', '', Math.round(g.value), fmtD(g.firstSold), fmtD(g.lastSold), spellingsOf(g).map(([s]) => s).join(' | '), g.why]),
    ...unsure.map((g) => ['несигурно — НЕ', spellingsOf(g)[0][0], (g.candidates || []).map((p) => p.name).join(' | ') || g.suggest || '', '', '', '', Math.round(g.value), fmtD(g.firstSold), fmtD(g.lastSold), spellingsOf(g).map(([s]) => s).join(' | '), g.why]),
    ...excluded.map((g) => ['исклучено', spellingsOf(g)[0][0], '', '', '', '', Math.round(g.value), fmtD(g.firstSold), fmtD(g.lastSold), spellingsOf(g).map(([s]) => s).join(' | '), g.why]),
  ];
  const cell = (v) => { const s = String(v ?? ''); return /[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  writeFileSync(csvFile, `﻿${[cols, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`);
}

// ─── rollback ───────────────────────────────────────────────────────────────
async function rollback() {
  if (!args.run || !isUuid(args.run)) die('--rollback needs --run <id>.');
  const like = q(`%run ${args.run}%`);
  const [run] = await sqlRead(`select id, summary from public.data_repair_runs where key = ${q(KEY)} and dry_run = false and summary->>'run_id' = ${q(args.run)}`);
  if (!run) die(`run ${args.run} was never applied (no data_repair_runs row).`);
  const before = run.summary?.before || [];
  const [n] = await sqlRead(`select
      (select count(*) from public.product_aliases where note like ${like} and reviewed_by is null)::int as aliases,
      (select count(*) from public.product_aliases where note like ${like} and reviewed_by is not null)::int as reviewed,
      (select count(*) from public.products p where p.description like ${like}
         ${PRODUCT_REFERENCES.filter((t) => t !== 'product_aliases').map((t) => `and not exists (select 1 from public.${t} r where r.product_id = p.id)`).join('\n         ')}
         and not exists (select 1 from public.product_aliases a where a.product_id = p.id and not (a.note like ${like} and a.reviewed_by is null))
         and not exists (select 1 from public.inventory_logs l where l.product_id = p.id and coalesce(l.notes, '') not like ${like}))::int as products,
      (select count(*) from public.products p where p.description like ${like})::int as products_all`);
  console.log(`run ${args.run}: ${n.aliases} unreviewed alias rows (${n.reviewed} reviewed — kept) · ${n.products}/${n.products_all} created products with no order line · ${before.length} activation rows to restore where unchanged since`);
  if (!args.apply) { console.log('dry run — add --apply to roll back.'); return; }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  await sql(buildRollbackSql({ key: KEY, runId: args.run, before, actorId: actor.id, actorEmail: actor.email,
    auditPayload: { ...n, restored: before.length }, invNote: `complete-catalogue ROLLBACK run ${args.run}` }));
  ok('rolled back');
}
