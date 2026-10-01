#!/usr/bin/env node
/**
 * check-profit-vat — READ-ONLY end-to-end check of the per-product VAT before (and after)
 * migration 20260944000900 is applied: the migration's insights_profit() query text (product
 * rates inlined from docs/vat/crm_products_vat.json while products.vat_rate does not exist)
 * → the api's own insightsProfit.ts buildProfitResponse → the invariants the Pure Profit tab
 * relies on:
 *   V1  the VAT line = Σ per line (the RPC's vt), on both clocks
 *   V2  Σ departments = the total (VAT, its 5 % / 18 % parts, the unclassified part)
 *   V3  the parts add up: Σ parts' VAT = the VAT line, Σ parts' revenue = the revenue
 *   V4  Σ products' VAT = the cohort's VAT line (± a denar per product row)
 *   V5  meta.vat says per_product_sigma, default 5 %
 * Once the profit body carries the Sigma costs (cache version >= 6, 20260945000800) it checks the LIVE
 * insights_profit() — the one the tab runs — instead of 0900's query text (VAT is untouched by the costs).
 *
 *   node scripts/vat/check-profit-vat.mjs --from 2026-09-22 --to 2026-09-28
 *
 * Pinned to Macedonia through scripts/verify-insights-ties.mjs runSql (single SELECT / WITH,
 * read_only: true). Nothing is written.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from '../verify-insights-ties.mjs';
import { migrationQueries } from '../verify-tab-profit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260944000900_product_vat_rate.sql');
const TABLE = join(ROOT, 'docs', 'vat', 'crm_products_vat.json');
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const n = (v) => Number(v) || 0;
const sum = (xs, f) => (xs ?? []).reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x?.[f]), 0);

async function loadTs(name) {
  const file = join(ROOT, 'supabase', 'functions', 'api', name);
  try { return await import(pathToFileURL(file).href); } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    const esbuild = await import('esbuild');
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

function inlineRates(q) {
  const rows = JSON.parse(readFileSync(TABLE, 'utf8'));
  const values = rows.map((r) => `(${lit(r.id)}::uuid, ${Number(r.vat_rate).toFixed(3)}::numeric(4,3))`).join(',');
  return q.replace('p.vat_rate AS vat_n', `(SELECT b.r FROM (VALUES ${values}) b(id, r) WHERE b.id = p.id) AS vat_n`);
}

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const from = opt('--from', '2026-09-22'), to = opt('--to', '2026-09-28');

const IC = await loadTs('insightsCommon.ts');
const IP = await loadTs('insightsProfit.ts');
const w = IC.insightsWindows(from, to, false);
const [probe] = await runSql(`SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                                AND table_name = 'products' AND column_name = 'vat_rate') AS col`);
const [ver] = probe.col ? await runSql(`SELECT public.insights_profit_cache_version() AS v`) : [{ v: 0 }];
const live = Number(ver?.v) >= 6;
const q = migrationQueries(readFileSync(MIGRATION, 'utf8'));
const bind = (s) => (probe.col ? s : inlineRates(s)).replaceAll('$1', `${lit(w.fromIso)}::timestamptz`).replaceAll('$2', `${lit(w.toEndIso)}::timestamptz`)
  .replaceAll('$3', `${lit(w.days <= 62 ? 'day' : 'month')}::text`).replaceAll('$4', 'true');
const liveCall = (clock) => runSql(`SELECT public.insights_profit(${lit(w.fromIso)}::timestamptz, ${lit(w.toEndIso)}::timestamptz, ${lit(clock)}, NULL, true) AS jsonb_build_object`);
const [co] = live ? await liveCall('cohort') : await runSql(bind(q.cohort));
const [ca] = live ? await liveCall('cash') : await runSql(bind(q.cash));
const cohort = co.jsonb_build_object, cash = ca.jsonb_build_object;
const resp = IP.buildProfitResponse({ cohort, cash }, w, {
  defaultVatRate: 0.05, deliverEur: 2.439, returnEur: 0, rateSource: 'courier_rates', agentNames: new Set(),
}, new Date());

const fails = [];
const near = (a, b, tol) => Math.abs(n(a) - n(b)) <= tol;
for (const clock of ['cohort', 'cash']) {
  const c = resp[clock];
  const rpc = clock === 'cohort' ? cohort : cash;
  const vt = sum((rpc.agg ?? []).filter((a) => a.dim === 's' && a.g === 'collected'), 'vt');
  if (!near(c.total.vat_mkd, vt, 1)) fails.push(`V1 ${clock}: VAT ${c.total.vat_mkd} ≠ Σ per line ${vt.toFixed(2)}`);
  for (const f of ['vat_mkd', (r) => r.vat_unclassified.revenue_mkd, (r) => sum(r.vat_split, 'vat_mkd')]) {
    const a = sum(c.by_source, f), b = typeof f === 'function' ? f(c.total) : c.total[f];
    if (!near(a, b, 6)) fails.push(`V2 ${clock}: Σ departments ${a} ≠ total ${b}`);
  }
  for (const r of [...c.by_source, c.total]) {
    if (!near(sum(r.vat_split, 'vat_mkd'), r.vat_mkd, 1 + r.vat_split.length)) fails.push(`V3 ${clock} ${r.key}: parts' VAT ${sum(r.vat_split, 'vat_mkd')} ≠ ${r.vat_mkd}`);
    if (!near(sum(r.vat_split, 'revenue_mkd'), r.revenue_mkd, 1 + r.vat_split.length)) fails.push(`V3 ${clock} ${r.key}: parts' revenue ≠ ${r.revenue_mkd}`);
  }
}
const prodVat = sum(resp.products, 'vat_mkd') + n(resp.products_others?.vat_mkd);
if (!near(prodVat, resp.cohort.total.vat_mkd, 2 + resp.products.length * 0.5)) fails.push(`V4 Σ products' VAT ${prodVat} ≠ ${resp.cohort.total.vat_mkd}`);
if (resp.meta.vat.mode !== 'per_product_sigma' || resp.meta.vat.default_rate !== 0.05) fails.push(`V5 meta.vat ${JSON.stringify(resp.meta.vat).slice(0, 120)}`);

console.log(`check-profit-vat ${w.from} → ${w.to} · rates from ${probe.col ? 'products.vat_rate' : 'docs/vat (not applied yet)'} · ${live ? `live insights_profit (cost ${cohort.cost_mode})` : '0900 query text'}`);
for (const clock of ['cohort', 'cash']) {
  const t = resp[clock].total;
  console.log(`  ${clock.padEnd(6)} revenue ${t.revenue_mkd} · VAT ${t.vat_mkd} (${t.vat_split.map((p) => `${Math.round(p.rate * 100)}%: ${p.vat_mkd}`).join(' · ')}) · unclassified ${t.vat_unclassified.revenue_mkd} · net ${t.net_mkd}`);
}
const unc = resp.meta.vat.unclassified.cohort;
console.log(`  unclassified (cohort): MEX-only ${unc.mex_only_mkd} · no lines ${unc.no_lines_mkd} · unmatched names ${unc.unmatched_mkd} · products without a rate ${unc.no_rate_mkd}`);
console.log(fails.length ? `FAIL\n  ${fails.join('\n  ')}` : 'PASS  V1–V5');
process.exitCode = fails.length ? 1 : 0;
