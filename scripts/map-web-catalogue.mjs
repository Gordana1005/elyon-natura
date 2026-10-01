/**
 * Web catalogue → brand lines (owner 01.10.2026, "Производи 2.0", point 2). No shebang (repair-kit
 * convention).
 *
 * Reads the PUBLIC naturatherapy.mk catalogue (sitemaps + category pages, and a product / bundle page
 * only when no category page named it) — slowly (one request per --delay ms, default 1.200), with an
 * identifying User-Agent, cached for 24 h under exports/web-catalogue/cache/ (gitignored). The shop is
 * never written to (the live-shop no-change rule); nothing here needs its database.
 *
 * Then matches every CRM product (scripts/lib/web-catalogue-mk.mjs) and proposes a line:
 *   anchor              the 12 Bio Natural products (the `bionatural products/` folder) / BIONATURAL in the name
 *   web                 on the web → Ad Astra (on /adastra-nutrition) or Natura Therapy (the rest)
 *   parcels_bio_recent  not on the web, sold via BIO NATURAL in the last --recent-days (120) → Bio Natural
 *   parcels_natura      not on the web, ≥ 90 % of all its MEX parcels on NATURA → Natura Therapy
 * and says what would change:
 *   new        undecided → the proposed line
 *   overwrite  a line the web contradicts (e.g. Natura Therapy on the Ad Astra page, or a non-anchor
 *              Bio Natural product the web sells) — every one is printed
 *   keep       a line the rules never overwrite (an owner's Ad Astra / Dr.Becker tag, an anchor, a
 *              parcel-only suggestion against a set line) — printed when it differs
 *
 *   node scripts/map-web-catalogue.mjs                       # dry run (default): fetch, match, print, CSV
 *   node scripts/map-web-catalogue.mjs --offline             # use the cache only (no request)
 *   node scripts/map-web-catalogue.mjs --refresh             # ignore the cache age
 *   node scripts/map-web-catalogue.mjs --apply --actor <admin auth uuid> [--no-overwrite]
 *
 * --apply writes ONLY through public.products_set_brand_line(ids, line, actor) (audited, one audit_log
 * row per call): the `new` rows (still undecided at write time) and — unless --no-overwrite — the
 * `overwrite` rows (only while they still carry the line the dry run saw). 🛑 Macedonia only
 * (repair-kit guards). Touches products.brand_line* only.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, bold, yellow, die, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, parseArgs, printTable, q, qUuid, qUuidArray,
  isUuid, writeCsv, fileStamp,
} from './lib/repair-kit.mjs';
import {
  AD_ASTRA_CATEGORY, applyPlan, buildWebCatalogue, flightText, gridProducts, pageCards, pageProductId, productLd,
  proposeLines, sitemapLocs, slugOf,
} from './lib/web-catalogue-mk.mjs';

const SITE = 'https://naturatherapy.mk';
const UA = 'ElyonCRM-catalogue-map/1.0 (read-only; Natura Therapy MK back office)';
const CACHE = join(ROOT, 'exports', 'web-catalogue', 'cache');
const DAY_MS = 86_400_000;
const CHUNK = 1000;

let lastRequestAt = 0;
async function politeGet(url, { delay, refresh, offline }) {
  const file = join(CACHE, `${(slugOf(url) || 'index').replace(/[^a-z0-9.-]+/gi, '_')}${url.endsWith('.xml') ? '' : '.html'}`);
  if (existsSync(file) && (offline || (!refresh && Date.now() - statSync(file).mtimeMs < DAY_MS))) return readFileSync(file, 'utf8');
  if (offline) return null;
  const wait = lastRequestAt + delay - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequestAt = Date.now();
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xml' } });
  if (!res.ok) { console.log(yellow(`  ! ${url} → HTTP ${res.status}`)); return null; }
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(file, text, 'utf8');
  return text;
}

async function loadWeb(opts) {
  const robots = await politeGet(`${SITE}/robots.txt`, opts);
  if (robots && /^\s*Disallow:\s*\/\s*$/m.test(robots)) die('robots.txt disallows the whole site — refusing to read it.');
  const loc = async (name) => sitemapLocs(await politeGet(`${SITE}/sitemaps/${name}.xml`, opts) ?? '');
  const productSlugs = (await loc('products')).map(slugOf);
  const bundleSlugs = (await loc('bundles')).map(slugOf);
  const categorySlugs = (await loc('categories')).map(slugOf);
  if (!productSlugs.length) die('sitemaps/products.xml gave no product — the shop changed? (or --offline without a cache)');
  if (!categorySlugs.includes(AD_ASTRA_CATEGORY)) die(`sitemaps/categories.xml has no /${AD_ASTRA_CATEGORY} — refusing to guess the Ad Astra products.`);

  const pages = new Map();
  const read = async (slug) => {
    const html = await politeGet(`${SITE}/${slug}`, opts);
    if (!html) return;
    const flight = flightText(html);
    pages.set(slug, { cards: pageCards(html), grid: gridProducts(flight), ld: productLd(html), productId: pageProductId(flight) });
  };
  console.log(`  web: ${productSlugs.length} products · ${bundleSlugs.length} bundles · ${categorySlugs.length} categories (sitemaps)`);
  for (const c of categorySlugs) await read(c);
  // a product / bundle page only when no category page gave its name
  let web = buildWebCatalogue({ productSlugs, bundleSlugs, pages });
  const unnamed = web.filter((w) => !w.name);
  if (unnamed.length) console.log(`  reading ${unnamed.length} product / bundle pages no category page named …`);
  for (const w of unnamed) await read(w.slug);
  web = buildWebCatalogue({ productSlugs, bundleSlugs, pages });
  const adastra = pages.get(AD_ASTRA_CATEGORY);
  if (!adastra || !(adastra.cards.length || adastra.grid.length)) die(`/${AD_ASTRA_CATEGORY} gave no product — refusing to guess the Ad Astra products.`);
  return web;
}

async function loadCrm(recentDays) {
  return sqlRead(`
    WITH par AS (
      SELECT x.pid,
             count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'bio_natural')::int AS bio,
             count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'natura')::int AS nat,
             count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'bio_natural' AND o.created_at >= now() - make_interval(days => ${Number(recentDays)}))::int AS bio_recent,
             count(DISTINCT o.id) FILTER (WHERE o.mex_account = 'natura' AND o.created_at >= now() - make_interval(days => ${Number(recentDays)}))::int AS nat_recent
        FROM public.orders o
        CROSS JOIN LATERAL (
          SELECT oi.product_id AS pid FROM public.order_items oi WHERE oi.order_id = o.id AND oi.product_id IS NOT NULL
          UNION SELECT o.product_id WHERE o.product_id IS NOT NULL) x
       WHERE o.mex_account IN ('bio_natural', 'natura')
       GROUP BY x.pid)
    SELECT p.id, p.name, p.sku, p.is_active, p.brand_line,
           coalesce(par.bio, 0) AS bio, coalesce(par.nat, 0) AS nat,
           coalesce(par.bio_recent, 0) AS bio_recent, coalesce(par.nat_recent, 0) AS nat_recent
      FROM public.products p LEFT JOIN par ON par.pid = p.id
     ORDER BY lower(p.name), p.id`);
}

/**
 * The web shop's own order history per CRM product: the CRM mirror of the shop's order lines
 * (web_order_items, read-only) → product_aliases (the 28.09 catalogue import) → products.
 */
async function loadWebSales() {
  const rows = await sqlRead(`
    WITH w AS (SELECT public.product_alias_norm(i.name) AS n, i.product_id AS shop_id, count(*)::int AS c
                 FROM public.web_order_items i GROUP BY 1, 2)
    SELECT a.product_id AS id, w.shop_id, sum(w.c)::int AS lines
      FROM w JOIN public.product_aliases a ON a.alias_norm = w.n AND a.kind = 'product'
     GROUP BY a.product_id, w.shop_id`);
  const out = new Map();
  for (const r of rows) {
    const m = out.get(r.id) ?? new Map();
    const key = r.shop_id == null ? null : Number(r.shop_id);
    m.set(key, (m.get(key) ?? 0) + Number(r.lines));
    out.set(r.id, m);
  }
  return out;
}

const LABEL = { natura_therapy: 'Natura Therapy', bio_natural: 'Bio Natural', ad_astra: 'Ad Astra', dr_becker: 'Dr.Becker' };
const cut = (s, n = 46) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
const row = (r) => ({ name: cut(r.name), now: r.current ? LABEL[r.current] : '—', proposed: r.proposed ? LABEL[r.proposed] : '—', source: r.how ? `${r.source}/${r.how}` : r.source, web: cut(r.web.join(' '), 40) });

export function summarise(rows) {
  const count = (pred) => rows.filter(pred).length;
  const by = (key) => Object.fromEntries(Object.keys(LABEL).map((l) => [l, count((r) => r[key] === l)]));
  return {
    products: rows.length,
    proposed: by('proposed'),
    bySource: Object.fromEntries(['anchor', 'web', 'web_history', 'family', 'parcels_bio_recent', 'parcels_natura', 'none']
      .map((s) => [s, count((r) => r.source === s)])),
    change: Object.fromEntries(['new', 'same', 'overwrite', 'keep', 'none'].map((c) => [c, count((r) => r.change === c)])),
    notes: Object.fromEntries(['anchor_namesake', 'web_mixed', 'web_partial', 'parcels_mixed', 'few_parcels'].map((n) => [n, count((r) => r.note === n)])),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'help', 'offline', 'refresh', 'no-overwrite'], values: ['actor', 'delay', 'recent-days'],
  });
  if (args.help) { console.log('usage: see the header of scripts/map-web-catalogue.mjs'); return; }
  const APPLY = !!args.apply;
  const delay = args.delay ? Number(args.delay) : 1200;
  if (!Number.isFinite(delay) || delay < 500) die('--delay must be ≥ 500 ms (be polite to the live shop).');
  const recentDays = args['recent-days'] ? Number(args['recent-days']) : 120;
  if (!Number.isInteger(recentDays) || recentDays < 7 || recentDays > 730) die('--recent-days must be 7..730');
  if (APPLY && !isUuid(args.actor)) die('--apply needs --actor <auth user uuid of an active admin / owner> (audit_log.actor_id).');

  mkGuard();
  await assertRemoteIsMk();

  console.log(bold('\nThe web catalogue (naturatherapy.mk, public pages only)'));
  const web = await loadWeb({ delay, refresh: !!args.refresh, offline: !!args.offline });
  const wp = web.filter((w) => w.type === 'product');
  const wb = web.filter((w) => w.type === 'bundle');
  console.log(`  ${wp.length} products (${wp.filter((w) => w.adAstra).length} Ad Astra) · ${wb.length} bundles (${wb.filter((w) => w.adAstra).length} on the Ad Astra page) · ${web.filter((w) => !w.name).length} without a name`);

  const crm = await loadCrm(recentDays);
  const webSales = await loadWebSales();
  const rows = proposeLines({ crm, web, webSales });
  const s = summarise(rows);
  const webMatched = new Set(rows.flatMap((r) => (r.source === 'web' ? r.web : [])));
  console.log(bold(`\nCRM products: ${s.products}`));
  console.log(`  web products matched to ≥ 1 CRM product: ${wp.filter((w) => webMatched.has(w.slug)).length} of ${wp.length}`);
  console.log(`  proposed: ${Object.entries(s.proposed).map(([k, v]) => `${LABEL[k]} ${v}`).join(' · ')} · none ${s.bySource.none}`);
  console.log(`  by source: ${Object.entries(s.bySource).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  change: ${Object.entries(s.change).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  console.log(`  notes: ${Object.entries(s.notes).map(([k, v]) => `${k} ${v}`).join(' · ')}`);

  const overwrite = rows.filter((r) => r.change === 'overwrite');
  if (overwrite.length) { console.log(bold(`\nOVERWRITE — the web says otherwise (${overwrite.length}):`)); printTable(overwrite.map(row)); }
  const keep = rows.filter((r) => r.change === 'keep');
  if (keep.length) { console.log(bold(`\nKEPT although the proposal differs (${keep.length}) — the owner decides:`)); printTable(keep.map(row)); }
  const namesakes = rows.filter((r) => r.note === 'anchor_namesake');
  if (namesakes.length) {
    console.log(bold(`\nA Bio Natural anchor NAME that is a Natura Therapy namesake (${namesakes.length}) — on the web, parcels on NATURA:`));
    printTable(namesakes.map(row));
  }
  const bioByParcels = rows.filter((r) => r.source === 'parcels_bio_recent');
  if (bioByParcels.length) {
    console.log(bold(`\nBio Natural by the BIO NATURAL parcels of the last ${recentDays} days, not on the web (${bioByParcels.length}) — check the names:`));
    printTable(bioByParcels.map((r) => ({ ...row(r), note: r.note })));
  }
  const mixed = rows.filter((r) => r.note === 'web_mixed' && !r.proposed);
  if (mixed.length) { console.log(bold(`\nWeb evidence names both lines (${mixed.length}) — no proposal:`)); printTable(mixed.map(row)); }
  const unmatchedWeb = wp.filter((w) => !webMatched.has(w.slug));
  if (unmatchedWeb.length) {
    console.log(bold(`\nWeb products with no CRM product (${unmatchedWeb.length}):`));
    printTable(unmatchedWeb.map((w) => ({ slug: w.slug, name: cut(w.name ?? ''), line: w.adAstra ? 'Ad Astra' : 'Natura Therapy' })));
  }

  const plan = applyPlan(rows, { allowOverwrite: !args['no-overwrite'] });
  console.log(bold(`\n--apply would set: `) + (plan.map((c) => `${LABEL[c.line]} ${c.ids.length}`).join(' · ') || 'nothing'));

  if (!APPLY) {
    const stamp = fileStamp();
    const file = writeCsv(`web-catalogue-lines-${stamp}.csv`, rows.map((r) => ({
      product_id: r.id, name: r.name, sku: r.sku ?? '', active: r.active, line_now: r.current ?? '', proposed: r.proposed ?? '',
      source: r.source, how: r.how ?? '', change: r.change, note: r.note, anchor: r.anchor ?? '', web: r.web.join(' '),
      web_shop_lines: r.webSales,
    })));
    const wfile = writeCsv(`web-catalogue-items-${stamp}.csv`, web.map((w) => ({
      slug: w.slug, type: w.type, name: w.name ?? '', shop_product_id: w.productId ?? '', manufacturer: w.manufacturer ?? '',
      line: w.adAstra ? 'ad_astra' : 'natura_therapy', categories: w.categories.join(' '),
    })));
    ok(`the whole map → ${file}`);
    ok(`the web catalogue → ${wfile}`);
    console.log(yellow('\n  dry run — nothing written. Review, then: --apply --actor <admin auth uuid>'));
    return;
  }

  // ── apply ──
  const [actor] = await sql(`SET TRANSACTION READ ONLY;
    SELECT u.email, public.is_business_owner(u.id) AS owner FROM auth.users u WHERE u.id = ${qUuid(args.actor)};`);
  if (!actor) die(`--actor ${args.actor}: no such auth user.`);
  if (!actor.owner) die(`--actor ${actor.email}: not an active admin / owner (is_business_owner() = false).`);
  ok(`actor ${actor.email}`);
  const expected = new Map(rows.map((r) => [r.id, r.current]));
  let updated = 0;
  for (const c of plan) {
    for (let i = 0; i < c.ids.length; i += CHUNK) {
      const ids = c.ids.slice(i, i + CHUNK);
      // Only rows still on the line the dry run saw (undecided, or the contradicted line) — a line the
      // owner changed meanwhile is never overwritten.
      const cond = ids.map((id) => `(p.id = ${qUuid(id)} AND p.brand_line IS NOT DISTINCT FROM ${q(expected.get(id))})`).join(' OR ');
      const [res] = await sql(`WITH ids AS (
          SELECT coalesce(array_agg(p.id), '{}') AS a FROM public.products p
           WHERE p.id = ANY (${qUuidArray(ids)}) AND (${cond}))
        SELECT CASE WHEN cardinality(ids.a) > 0
                    THEN public.products_set_brand_line(ids.a, ${q(c.line)}, ${qUuid(args.actor)}) END AS r
          FROM ids;`);
      const r = typeof res?.r === 'string' ? JSON.parse(res.r) : res?.r;
      const n = Number(r?.updated ?? 0);
      updated += n;
      ok(`${LABEL[c.line]}: ${n} set, ${ids.length - Number(r?.requested ?? 0)} changed meanwhile (skipped)`);
    }
  }
  ok(bold(`${updated} lines set (audit_log action products.set_brand_line).`));
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
