#!/usr/bin/env node
/**
 * compare-vat — READ-ONLY proof of the per-product VAT (migration 20260944000900,
 * docs/VAT.md): for a window of Skopje days it runs the migration's insights_profit()
 * query text and shows, per department and for the whole business, the VAT the old
 * way (collected revenue × 18/118) and the new way (Σ per line, the line's product
 * rate from Sigma), the 5 % / 18 % split and the unclassified part.
 *
 *   node scripts/vat/compare-vat.mjs --from 2026-09-01 --to 2026-09-30
 *   node scripts/vat/compare-vat.mjs --from 2026-09-01 --to 2026-09-30 --json
 *
 * Before the migration is applied products.vat_rate does not exist: the script then
 * reads each product's rate from docs/vat/crm_products_vat.json (the very table the
 * migration backfills), inlined into the query — the same numbers the function will
 * return once applied. It also checks that every measure the P&L had before (sales,
 * revenue, costed / uncosted / other value, cost, packages, bonus, parcels) is
 * IDENTICAL to the live insights_profit() — only VAT is new.
 *
 * Safety: pinned to Macedonia through scripts/verify-insights-ties.mjs runSql (every
 * statement a single SELECT / WITH, sent with read_only: true). Nothing is written.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from '../verify-insights-ties.mjs';
import { migrationQueries } from '../verify-tab-profit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260944000900_product_vat_rate.sql');
const TABLE = join(ROOT, 'docs', 'vat', 'crm_products_vat.json');
const OLD_RATE = 0.18;
const SOURCES = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];
const NAMES = {
  altercpa: 'Affiliate – Lead in', elyon_crm: 'Affiliate – Lead out', teleshop_out: 'Телешоп – Lead out',
  teleshop_other: 'Телешоп – Lead in', social: 'Социјални мрежи', web: 'Web', total: 'Вкупно',
};
const OLD_MEASURES = ['n', 'rev', 'card', 'pw', 'rc', 'ru', 'rn', 'cm', 'pc', 'pu', 'fr', 'lb'];

const n = (v) => (v == null ? 0 : Number(v) || 0);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function loadTs(name) {
  const file = join(ROOT, 'supabase', 'functions', 'api', name);
  try { return await import(pathToFileURL(file).href); } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    const esbuild = await import('esbuild');
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

function bind(q, { fromIso, toEndIso, gran }) {
  return q.replaceAll('$1', `${lit(fromIso)}::timestamptz`).replaceAll('$2', `${lit(toEndIso)}::timestamptz`)
    .replaceAll('$3', `${lit(gran)}::text`).replaceAll('$4', 'true');
}

/** The rate column → an inline lookup in the 01.10 table (before the migration is applied). */
function inlineRates(q) {
  const rows = JSON.parse(readFileSync(TABLE, 'utf8'));
  const values = rows.map((r) => `(${lit(r.id)}::uuid, ${Number(r.vat_rate).toFixed(3)}::numeric(4,3))`).join(',');
  const from = 'p.vat_rate AS vat_n';
  if (q.split(from).length !== 2) throw new Error('migration text: the kc rate column not found exactly once');
  return q.replace(from, `(SELECT b.r FROM (VALUES ${values}) b(id, r) WHERE b.id = p.id) AS vat_n`);
}

export async function compare({ from, to, sql = runSql }) {
  const IC = await loadTs('insightsCommon.ts');
  const w = IC.insightsWindows(from, to, false);
  if ('error' in w) throw new Error(w.error);
  const gran = w.days <= 62 ? 'day' : 'month';
  const [probe] = await sql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                               AND table_name = 'products' AND column_name = 'vat_rate') AS col`);
  const queries = migrationQueries(readFileSync(MIGRATION, 'utf8'));
  const prep = (q) => bind(probe.col ? q : inlineRates(q), { fromIso: w.fromIso, toEndIso: w.toEndIso, gran });
  const [[co], [ca], [liveCo], [liveCa]] = await Promise.all([
    sql(prep(queries.cohort)), sql(prep(queries.cash)),
    sql(`SELECT public.insights_profit(${lit(w.fromIso)}::timestamptz, ${lit(w.toEndIso)}::timestamptz, 'cohort', NULL, true) AS j`),
    sql(`SELECT public.insights_profit(${lit(w.fromIso)}::timestamptz, ${lit(w.toEndIso)}::timestamptz, 'cash', NULL, true) AS j`),
  ]);
  const cohort = co.jsonb_build_object, cash = ca.jsonb_build_object;

  // every pre-existing measure identical to the live function
  const diffs = [];
  for (const [clock, mine, live] of [['cohort', cohort, liveCo.j], ['cash', cash, liveCa.j]]) {
    const key = (a) => `${a.g}|${a.dim}|${a.key}`;
    const L = new Map((live.agg ?? []).map((a) => [key(a), a]));
    if ((mine.agg ?? []).length !== L.size) diffs.push(`${clock}: ${mine.agg?.length} agg rows ≠ live ${L.size}`);
    for (const a of mine.agg ?? []) {
      const b = L.get(key(a));
      if (!b) { diffs.push(`${clock} ${key(a)}: not in live`); continue; }
      for (const m of OLD_MEASURES) if (Math.abs(n(a[m]) - n(b[m])) > 1e-6) diffs.push(`${clock} ${key(a)}.${m}: ${a[m]} ≠ live ${b[m]}`);
    }
    if (clock === 'cohort') {
      if (JSON.stringify(mine.strip) !== JSON.stringify(live.strip)) diffs.push('cohort strip differs from live');
      if ((mine.products ?? []).length !== (live.products ?? []).length) diffs.push('cohort products: row count differs from live');
    }
  }

  const line = (clockRpc, src) => {
    const rows = (clockRpc.agg ?? []).filter((a) => a.g === 'collected' && a.dim === 's' && (src === 'total' || a.key === src));
    const s = (k) => rows.reduce((t, a) => t + n(a[k]), 0);
    const rev = s('rev');
    const oldVat = rev * OLD_RATE / (1 + OLD_RATE);
    const newVat = s('vt');
    return {
      key: src, name: NAMES[src], sales: s('n'), revenue: Math.round(rev),
      vat_old: Math.round(oldVat), vat_new: Math.round(newVat), diff: Math.round(newVat - oldVat),
      effective_rate: rev - newVat > 0 ? newVat / (rev - newVat) : null,
      rev_05: Math.round(s('v05')), rev_18: Math.round(s('v18')), rev_10: Math.round(s('v10')), rev_00: Math.round(s('v00')),
      vat_05: Math.round(s('v05') * 0.05 / 1.05), vat_18: Math.round(s('v18') * 0.18 / 1.18),
      unclassified_rev: Math.round(s('vu')), unclassified_vat: Math.round(s('vu') * 0.05 / 1.05),
    };
  };
  const table = (rpc) => [...SOURCES.map((k) => line(rpc, k)), line(rpc, 'total')];

  // the biggest products at 18 % and the unclassified keys (cohort, collected)
  const prod = new Map();
  for (const p of cohort.products ?? []) {
    if (p.g !== 'collected') continue;
    const a = prod.get(p.k) ?? { key: p.k, name: p.name, rate: n(p.vr), defaulted: !!p.vd, revenue: 0, vat: 0 };
    a.revenue += n(p.rev); a.vat += n(p.vt); a.defaulted = a.defaulted || !!p.vd;
    prod.set(p.k, a);
  }
  const all = [...prod.values()].map((p) => ({ ...p, revenue: Math.round(p.revenue), vat: Math.round(p.vat) }));
  return {
    window: { from: w.from, to: w.to, days: w.days, fromIso: w.fromIso, toEndIso: w.toEndIso },
    rates_from: probe.col ? 'products.vat_rate' : 'docs/vat/crm_products_vat.json (migration not applied yet)',
    unchanged: { ok: diffs.length === 0, diffs: diffs.slice(0, 30) },
    cohort: table(cohort),
    cash: table(cash),
    top18: all.filter((p) => p.rate === 0.18 && !p.defaulted).sort((a, b) => b.revenue - a.revenue).slice(0, 15),
    unclassified: all.filter((p) => p.defaulted).sort((a, b) => b.revenue - a.revenue).slice(0, 15),
  };
}

const fmt = (v) => (v == null ? '—' : Math.round(v).toLocaleString('de-DE'));
const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(2).replace('.', ',')} %`);

export function markdown(r) {
  const out = [];
  const tbl = (title, rows) => {
    out.push(`**${title}**`, '', '| Оддел | Продажби | Приход (ден) | ДДВ стар 18/118 | ДДВ нов (по производ) | Разлика | Ефективна стапка | Приход 5 % | Приход 18 % | Некласифицирано |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const x of rows) {
      out.push(`| ${x.key === 'total' ? `**${x.name}**` : x.name} | ${fmt(x.sales)} | ${fmt(x.revenue)} | ${fmt(x.vat_old)} | ${fmt(x.vat_new)} | ${fmt(x.diff)} | ${pct(x.effective_rate)} | ${fmt(x.rev_05)} | ${fmt(x.rev_18)} | ${fmt(x.unclassified_rev)} |`);
    }
    out.push('');
  };
  tbl(`Кохорта (продажби во ${r.window.from} – ${r.window.to}, наплатено)`, r.cohort);
  tbl(`Готовина (MEX испорачано во ${r.window.from} – ${r.window.to})`, r.cash);
  return out.join('\n');
}

function parseArgs(argv) {
  const o = { from: '2026-09-01', to: '2026-09-30', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--from' || a === '--to') o[a.slice(2)] = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

if (String(process.argv[1] ?? '').replace(/\\/g, '/').endsWith('vat/compare-vat.mjs')) {
  const o = parseArgs(process.argv.slice(2));
  compare(o).then((r) => {
    if (o.json) { console.log(JSON.stringify(r, null, 2)); return; }
    console.log(`compare-vat ${r.window.from} → ${r.window.to} (Skopje) · rates from ${r.rates_from}`);
    console.log(r.unchanged.ok ? 'PASS  every pre-existing P&L measure = the live insights_profit()' : `FAIL  measures differ from live:\n  ${r.unchanged.diffs.join('\n  ')}`);
    console.log('');
    console.log(markdown(r));
    console.log('Top products at 18 % (cohort, collected):');
    for (const p of r.top18) console.log(`  ${fmt(p.revenue).padStart(10)} ден  VAT ${fmt(p.vat).padStart(8)}  ${p.name}`);
    console.log('Unclassified (taxed at 5 %, shown apart):');
    for (const p of r.unclassified) console.log(`  ${fmt(p.revenue).padStart(10)} ден  VAT ${fmt(p.vat).padStart(8)}  ${p.key === '__mex_only__' ? 'MEX parcels without an order (contents unknown)' : p.key === '__unknown__' ? 'sales without lines' : (p.name ?? p.key)}`);
    process.exitCode = r.unchanged.ok ? 0 : 1;
  }, (e) => { console.error(`compare-vat error: ${e?.message ?? e}`); process.exitCode = 2; });
}
