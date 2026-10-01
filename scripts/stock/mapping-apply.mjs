/**
 * mapping-apply — loads the Stock v2 mapping that docs/stock/build_sigma_stock.py proposed (owner review:
 * exports/stock/Magacin-pregled-<date>.xlsx) into the Macedonian CRM, through the audited writers of
 * 20260945000400. No shebang (repo convention).
 *
 *   node scripts/stock/mapping-apply.mjs                         # DRY (default): every writer runs, all rolled back
 *   node scripts/stock/mapping-apply.mjs --apply --actor <uuid>  # one transaction, committed (the lead runs this)
 *   options: --dir exports/stock        the build's output folder
 *            --kits unstocked|all|none  default unstocked: a Sigma set that HAS stock in the 22.09 opening is left
 *                                       without components (the resolver expands a kit named on a parcel line —
 *                                       a set on the shelf must leave as the set, not as its singles)
 *            --refresh-articles         also re-send articles that already exist (stock_articles_upsert overwrites
 *                                       name / unit / class / brand / active — off by default: an owner's edit stays)
 *            --replace-approved         also re-propose recipes / aliases an owner already approved (off by default)
 *            --no-approve               load every recipe / alias as a proposal, even confidence high
 *            --only articles,kits,recipes,aliases,exempt
 *            --verbose                  print every writer result that is not ok
 *
 * Order (one transaction): Sigma articles → local articles (L00001…) → kits → recipes (product_articles_set,
 * valid_from -infinity, approve = confidence high) → aliases (stock_article_alias_set: [] = not stock) →
 * exemptions (product_stock_exempt_set). A writer that answers {ok:false} is listed and the rest goes on; the
 * transaction itself fails only on a SQL error (then nothing is written).
 *
 * Safety: Macedonia only (repair-kit guards); lock_timeout 2 s, statement_timeout 45 s; --apply needs an owner
 * actor (is_business_owner); nothing here moves stock — the engine (stock_v2_apply) does, only with the switch on.
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bold, die, ok, warn, yellow } from '../lib/repair-kit.mjs';
import { STOCK_DIR, anyOwner, args, guard, jlit, lit, loadJson, ownerActor, read, txRun, ulit } from './sigma-common.mjs';

const STEPS = ['articles', 'kits', 'recipes', 'aliases', 'exempt'];

/** What to send, from the build's files and the database as it is now (pure — unit-testable). */
export function plan({ files, db, opts }) {
  const out = { articles: [], local: [], kits: [], recipes: [], aliases: [], exempt: [], skipped: {} };
  const skip = (k) => { out.skipped[k] = (out.skipped[k] ?? 0) + 1; };
  const have = new Set(db.articles);
  for (const a of files.articles) {
    if (!opts.refreshArticles && have.has(a.code)) { skip('article_exists'); continue; }
    out.articles.push({ code: a.code, name: a.name, unit: a.unit, sigma_class: a.sigma_class, brand: a.brand, is_set: a.is_set, active: a.active });
  }
  for (const a of files.local ?? []) {
    if (!opts.refreshArticles && have.has(a.code)) { skip('local_exists'); continue; }
    out.local.push({ code: a.code, name: a.name, unit: a.unit, sigma_class: null, brand: a.brand, is_set: false, active: true });
  }
  const stocked = new Set((files.opening?.lines ?? []).filter((l) => l.qty > 0).map((l) => l.code));
  for (const k of files.kits) {
    if (opts.kits === 'none') { skip('kit_mode_none'); continue; }
    if (opts.kits === 'unstocked' && stocked.has(k.kit_code)) { skip('kit_has_opening_stock'); continue; }
    out.kits.push(k);
  }
  const products = new Set(db.products);
  const approved = new Set(db.approvedRecipes);
  for (const r of files.recipes) {
    if (!products.has(r.product_id)) { skip('recipe_product_missing'); continue; }
    if (!opts.replaceApproved && approved.has(r.product_id)) { skip('recipe_already_approved'); continue; }
    out.recipes.push({ ...r, approve: !opts.noApprove && r.confidence === 'high' });
  }
  const aliasApproved = new Set(db.approvedAliases);
  const norm = (src, key) => (['collabbox_code', 'web_sku', 'web_product'].includes(src) ? String(key).trim().toUpperCase() : String(key).trim().toLowerCase().replace(/\s+/g, ' '));
  for (const a of files.aliases) {
    if (!opts.replaceApproved && aliasApproved.has(`${a.source}|${norm(a.source, a.key)}`)) { skip('alias_already_approved'); continue; }
    out.aliases.push({ ...a, approve: !opts.noApprove && !!a.approve });
  }
  for (const e of files.exempt ?? []) {
    if (!products.has(e.product_id)) { skip('exempt_product_missing'); continue; }
    out.exempt.push(e);
  }
  return out;
}

function stepsSql(p, actor, only) {
  const s = [];
  const A = ulit(actor);
  if (only.includes('articles')) {
    if (p.articles.length) s.push({ k: 'articles:sigma', sql: `public.stock_articles_upsert(${jlit(p.articles)}, 'sigma', ${A}, false)` });
    if (p.local.length) s.push({ k: 'articles:local', sql: `public.stock_articles_upsert(${jlit(p.local)}, 'local', ${A}, false)` });
  }
  if (only.includes('kits') && p.kits.length) {
    s.push({ k: 'kits', sql: `public.stock_article_kits_upsert(${jlit(p.kits)}, ${A})` });
  }
  if (only.includes('recipes')) {
    for (const r of p.recipes) {
      s.push({ k: `recipe:${r.product_id}`, sql: `public.product_articles_set(${ulit(r.product_id)}, ${jlit(r.lines.map((l) => ({ code: l.code, qty: l.qty, role: l.role })))}, NULL, ${lit(`stock_v2_build:${r.source}`)}, ${lit(r.confidence)}, ${r.approve}, ${lit(r.note || null)}, ${A})` });
    }
  }
  if (only.includes('aliases')) {
    for (const a of p.aliases) {
      const lines = a.kind === 'not_stock' ? [] : a.lines.map((l) => ({ code: l.code, qty: l.qty }));
      s.push({ k: `alias:${a.source}:${a.key}`, sql: `public.stock_article_alias_set(${lit(a.source)}, ${lit(a.key)}, ${jlit(lines)}, ${a.approve}, ${A})` });
    }
  }
  if (only.includes('exempt') && p.exempt.length) {
    const byReason = new Map();
    for (const e of p.exempt) { if (!byReason.has(e.reason)) byReason.set(e.reason, []); byReason.get(e.reason).push(e.product_id); }
    for (const [reason, ids] of byReason) {
      s.push({ k: 'exempt', sql: `public.product_stock_exempt_set(ARRAY[${ids.map(ulit).join(',')}], true, ${lit(reason)}, ${A})` });
    }
  }
  return s;
}

function summarise(results, verbose) {
  const by = {};
  const bad = [];
  for (const { k, v } of results) {
    const kind = k.split(':')[0];
    by[kind] ??= { calls: 0, ok: 0, failed: 0 };
    by[kind].calls++;
    if (v?.ok) by[kind].ok++; else { by[kind].failed++; bad.push({ k, v }); }
    if (kind === 'articles' || kind === 'kits' || kind === 'exempt') console.log(`  ${k}: ${JSON.stringify(v).slice(0, 400)}`);
  }
  console.log(bold('\nWriters:'));
  for (const [k, c] of Object.entries(by)) console.log(`  ${k.padEnd(9)} calls ${c.calls} · ok ${c.ok} · not ok ${c.failed}`);
  if (bad.length) {
    console.log(yellow(`\n${bad.length} writer call(s) answered ok:false (nothing written for them):`));
    for (const b of bad.slice(0, verbose ? bad.length : 15)) console.log(`  ${b.k}: ${JSON.stringify(b.v).slice(0, 300)}`);
  }
  const approved = results.filter((r) => r.k.startsWith('recipe:') && r.v?.ok && r.v.status === 'approved').length;
  const proposed = results.filter((r) => r.k.startsWith('recipe:') && r.v?.ok && r.v.status === 'proposed').length;
  console.log(`  recipes: ${approved} approved · ${proposed} proposed`);
  return bad.length;
}

async function main() {
  const a = args(process.argv.slice(2), {
    flags: ['apply', 'refresh-articles', 'replace-approved', 'no-approve', 'verbose', 'help'],
    values: ['actor', 'dir', 'kits', 'only'],
  });
  if (a.help) { console.log('see the header of scripts/stock/mapping-apply.mjs'); return; }
  const dir = a.dir ?? STOCK_DIR;
  const opts = { kits: a.kits ?? 'unstocked', refreshArticles: !!a['refresh-articles'], replaceApproved: !!a['replace-approved'],
    noApprove: !!a['no-approve'] };
  if (!['unstocked', 'all', 'none'].includes(opts.kits)) die('--kits must be unstocked, all or none');
  const only = a.only ? a.only.split(',').map((s) => s.trim()) : STEPS;
  for (const s of only) if (!STEPS.includes(s)) die(`--only: unknown step ${s} (${STEPS.join(', ')})`);
  if (a.apply && !a.actor) die('--apply needs --actor <auth uuid of an owner> (audit_log.actor_id).');

  const files = {
    articles: loadJson(dir, 'articles.json'), local: loadJson(dir, 'local-articles.json', { optional: true }) ?? [],
    kits: loadJson(dir, 'kits.json'), recipes: loadJson(dir, 'recipes.json'), aliases: loadJson(dir, 'aliases.json'),
    exempt: loadJson(dir, 'exempt.json', { optional: true }) ?? [],
    opening: loadJson(dir, 'openings.json').variants['04_morning_2209'],
  };
  await guard();
  const fn = await read(`select to_regprocedure('public.product_articles_set(uuid,jsonb,timestamptz,text,text,boolean,text,uuid)') is not null as ok`);
  if (!fn[0]?.ok) die('the Stock v2 writers (20260945000400) are not applied.');
  const actor = a.apply ? await ownerActor(a.actor) : await anyOwner();
  const db = {
    articles: (await read('select code from public.stock_articles')).map((r) => r.code),
    products: (await read('select id from public.products')).map((r) => r.id),
    approvedRecipes: (await read("select distinct product_id from public.product_articles where status = 'approved'")).map((r) => r.product_id),
    approvedAliases: (await read("select source || '|' || key as k from public.stock_article_aliases where status = 'approved'")).map((r) => r.k),
  };
  const p = plan({ files, db, opts });
  console.log(bold(`\nMapping plan (${dir})`));
  console.log(`  articles: ${p.articles.length} Sigma + ${p.local.length} local · kits: ${p.kits.length} (${opts.kits}) · recipes: ${p.recipes.length} ` +
    `(${p.recipes.filter((r) => r.approve).length} approve) · aliases: ${p.aliases.length} (${p.aliases.filter((x) => x.approve).length} approve) · exempt: ${p.exempt.length}`);
  if (Object.keys(p.skipped).length) console.log(`  skipped: ${Object.entries(p.skipped).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
  const steps = stepsSql(p, actor.id, only);
  if (!steps.length) { ok('nothing to send.'); return; }

  const t0 = Date.now();
  const results = await txRun(steps, { dry: !a.apply });
  const bad = summarise(results, !!a.verbose);
  console.log(`  ${steps.length} writer calls in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!a.apply) {
    console.log(yellow(`\n  DRY RUN — every writer ran inside one transaction and it was ROLLED BACK (actor for the preview: ${actor.email}).`));
    console.log(yellow('  To load: node scripts/stock/mapping-apply.mjs --apply --actor <owner auth uuid>'));
  } else {
    ok(bold(`committed by ${actor.email}${bad ? ` (${bad} calls answered ok:false — listed above)` : ''}.`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
