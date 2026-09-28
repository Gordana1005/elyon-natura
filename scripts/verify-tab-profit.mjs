/**
 * verify-tab-profit — READ-ONLY proof that Insights → Pure Profit / Margins
 * (migration 20260941000300_insights_profit, GET /api/insights/profit) ties
 * to the foundation and adds up.
 *
 *   node scripts/verify-tab-profit.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-tab-profit.mjs --from 2026-09-01 --to 2026-09-27 --json
 *
 *   --from/--to  Skopje calendar days, inclusive (default: the 7 days ending today);
 *                windows from the api's own helper (insightsCommon.ts insightsWindows).
 *   --json       one JSON document on stdout instead of the report
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / unreachable.
 *
 * It runs public.insights_profit() when the migration is applied; before that it
 * runs the migration's OWN query text (cut out of the file, the bounds as literals),
 * so the numbers it checks are the ones the function will return.
 *
 *   P1  the cohort strip = insights_cohort, source by source, bucket by bucket
 *       (count, value, COD, orders / web / MEX-only), outside the total too
 *   P2  cohort P&L revenue = the cohort's collected part (paid + paid by ruling),
 *       its returned / open / unproven groups = the cohort's buckets
 *   P3  cash P&L revenue = insights_cohort cash_flow (MEX COD + card), parcels too
 *   P4  every denar of a sale reaches its lines: Σ (costed + uncosted + other
 *       revenue) = the sale value, per source and group, both clocks
 *   P5  the grains agree: Σ days = Σ sources = Σ webmasters (AlterCPA); Σ product
 *       revenue / known cost = the P&L's
 *   P6  the api's P&L (insightsProfit.ts, the same file the api runs): Σ sources =
 *       total on every line, VAT = revenue × r/(1+r), courier = parcels × the MEX
 *       rate, Σ product commission = the commission line, net = revenue − costs
 *   H   the headline numbers of both clocks
 *
 * Safety: pinned to Macedonia (the guard, runSql and assertReadOnly of
 * scripts/verify-insights-ties.mjs — every statement a single SELECT / WITH, sent
 * with read_only: true). Nothing is written. The token is never printed.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000300_insights_profit.sql');
const EXIT = { OK: 0, FAIL: 1, ERROR: 2 };
const VAT_RATE = 0.18;           // index.ts VAT_RATE
class UsageError extends Error {}

const n = (v) => (v == null ? 0 : Number(v) || 0);
const sum = (list, f) => (list ?? []).reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x?.[f]), 0);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function loadTs(name) {
  const file = join(ROOT, 'supabase', 'functions', 'api', name);
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    let esbuild;
    try { esbuild = await import('esbuild'); } catch {
      throw new UsageError('this Node cannot load TypeScript: use Node >= 22.18 (or 22.6+ with --experimental-strip-types), or npm ci');
    }
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

/** The query texts the migration's function EXECUTEs, verbatim. */
export function migrationQueries(text) {
  const cut = (tag) => {
    const a = text.indexOf(`$${tag}$`);
    const b = text.indexOf(`$${tag}$`, a + tag.length + 2);
    if (a < 0 || b < 0) throw new Error(`migration: $${tag}$ block not found`);
    return text.slice(a + tag.length + 2, b);
  };
  const common = cut('cm');
  return { cohort: cut('hc') + common + cut('tc'), cash: cut('hh') + common + cut('th') };
}

function bind(q, { fromIso, toEndIso, gran, detail }) {
  return q.replaceAll('$1', `${lit(fromIso)}::timestamptz`).replaceAll('$2', `${lit(toEndIso)}::timestamptz`)
    .replaceAll('$3', `${lit(gran)}::text`).replaceAll('$4', detail ? 'true' : 'false');
}

async function profitRpc(sql, live, queries, w, clock, gran) {
  if (live) {
    const r = await sql(`SELECT public.insights_profit(${lit(w.fromIso)}::timestamptz, ${lit(w.toEndIso)}::timestamptz, ${lit(clock)}, NULL, true) AS j`);
    return r[0].j;
  }
  const r = await sql(bind(queries[clock], { fromIso: w.fromIso, toEndIso: w.toEndIso, gran, detail: true }));
  return r[0].jsonb_build_object;
}

export async function verify({ from, to, sql, now = new Date() }) {
  const IC = await loadTs('insightsCommon.ts');
  const IP = await loadTs('insightsProfit.ts');
  const w = IC.insightsWindows(from, to, false, now);
  if ('error' in w) throw new UsageError(w.error);
  const gran = w.days <= 62 ? 'day' : 'month';
  const probe = await sql(`SELECT to_regprocedure('public.insights_profit(timestamptz,timestamptz,text,text,boolean)') IS NOT NULL AS live`);
  const live = probe[0].live === true;
  const queries = migrationQueries(readFileSync(MIGRATION, 'utf8'));

  const [cohort, cash, coRows, people, rates] = await Promise.all([
    profitRpc(sql, live, queries, w, 'cohort', gran),
    profitRpc(sql, live, queries, w, 'cash', gran),
    sql(`SELECT public.insights_cohort(${lit(w.fromIso)}::timestamptz, ${lit(w.toEndIso)}::timestamptz, NULL, NULL, NULL, true) AS j`),
    sql(`SELECT (SELECT json_agg(json_build_object('user_id', user_id, 'full_name', full_name)) FROM public.profiles) AS profiles,
                (SELECT json_agg(json_build_object('user_id', user_id, 'role', role)) FROM public.user_roles
                  WHERE role IN ('agent','pending_agent','prediction_agent','admin','manager')) AS roles`),
    sql(`SELECT courier, service, deliver_cost, return_cost FROM public.courier_rates WHERE courier = 'mex'`),
  ]);
  const co = coRows[0].j;
  const results = [];
  const check = (id, title, fails, info = []) => results.push({ id, title, status: fails.length ? 'FAIL' : 'PASS', fails, info });
  const near = (a, b, tol) => Math.abs(n(a) - n(b)) <= tol;

  // P1 — the strip = insights_cohort
  {
    const fails = [];
    const strip = IP.buildStrip(cohort.strip);
    const cmp = (label, a, b) => {
      for (const k of ['count', 'value_mkd', 'cod_mkd', 'orders', 'web', 'mex_only']) {
        if (b?.[k] === undefined) continue;
        if (!near(a?.[k], b?.[k], 1)) fails.push(`${label}.${k}: profit ${n(a?.[k])} ≠ cohort ${n(b?.[k])}`);
      }
    };
    cmp('total', strip.total, co.total);
    for (const b of co.buckets) cmp(`bucket ${b.key}`, strip.buckets.find((x) => x.key === b.key), b);
    for (const o of co.outside) cmp(`outside ${o.key}`, strip.outside.find((x) => x.key === o.key), o);
    for (const s of co.by_source) {
      const mine = strip.by_source.find((x) => x.key === s.key);
      cmp(`${s.key} total`, mine?.total, s.total);
      for (const b of s.buckets) cmp(`${s.key} ${b.key}`, mine?.buckets.find((x) => x.key === b.key), b);
    }
    check('P1', 'cohort strip = insights_cohort (every source × bucket)', fails, [`total ${co.total.count} · ${co.total.value_mkd} ден`]);
  }

  // P2 — cohort groups = cohort buckets
  {
    const fails = [];
    const byG = (g) => (cohort.agg ?? []).filter((a) => a.dim === 's' && a.g === g);
    const bk = (keys) => co.buckets.filter((b) => keys.includes(b.key));
    const pairs = [
      ['collected', ['paid', 'paid_legacy']], ['returned', ['returned']],
      ['open', ['courier', 'courier_problem', 'label', 'to_pack']], ['unproven', ['paid_unproven']],
    ];
    for (const [g, keys] of pairs) {
      const a = byG(g), b = bk(keys);
      if (sum(a, 'n') !== sum(b, 'count')) fails.push(`${g}: ${sum(a, 'n')} sales ≠ cohort ${sum(b, 'count')}`);
      if (!near(sum(a, 'rev'), sum(b, 'value_mkd'), 2)) fails.push(`${g}: ${sum(a, 'rev')} ден ≠ cohort ${sum(b, 'value_mkd')}`);
    }
    check('P2', 'cohort P&L groups = the cohort buckets (collected = paid + paid by ruling)', fails,
      [`collected ${sum(byG('collected'), 'n')} · ${Math.round(sum(byG('collected'), 'rev'))} ден`]);
  }

  // P3 — cash = cash_flow
  {
    const fails = [];
    const a = (cash.agg ?? []).filter((x) => x.dim === 's' && x.g === 'collected');
    const cf = co.cash_flow;
    if (!near(sum(a, 'rev'), n(cf.cod_mkd) + n(cf.card_mkd), 2)) fails.push(`cash revenue ${sum(a, 'rev')} ≠ COD ${cf.cod_mkd} + card ${cf.card_mkd}`);
    if (!near(sum(a, 'card'), cf.card_mkd, 2)) fails.push(`card ${sum(a, 'card')} ≠ ${cf.card_mkd}`);
    if (sum(a, 'n') !== n(cf.parcels)) fails.push(`parcels ${sum(a, 'n')} ≠ ${cf.parcels}`);
    check('P3', 'cash P&L = insights_cohort cash_flow (MEX COD + card)', fails, [`${cf.parcels} parcels · ${n(cf.cod_mkd) + n(cf.card_mkd)} ден`]);
  }

  // P4 — every denar reaches its lines
  {
    const fails = [];
    for (const [clock, r] of [['cohort', cohort], ['cash', cash]]) {
      for (const a of (r.agg ?? []).filter((x) => x.dim === 's' && (x.g === 'collected' || x.g === 'returned'))) {
        const lines = n(a.rc) + n(a.ru) + n(a.rn);
        if (!near(lines, a.rev, 1 + n(a.n) * 0.01)) fails.push(`${clock} ${a.g} ${a.key}: lines ${lines.toFixed(2)} ≠ sales ${a.rev}`);
      }
    }
    check('P4', 'Σ line revenue (costed + uncosted + non-product) = sale value', fails);
  }

  // P5 — grains agree
  {
    const fails = [];
    for (const [clock, r] of [['cohort', cohort], ['cash', cash]]) {
      for (const g of ['collected', 'returned']) {
        const S = (r.agg ?? []).filter((x) => x.dim === 's' && x.g === g);
        const D = (r.agg ?? []).filter((x) => x.dim === 'd' && x.g === g);
        const W = (r.agg ?? []).filter((x) => x.dim === 'w' && x.g === g);
        const A = S.filter((x) => x.key === 'altercpa');
        for (const f of ['n', 'rev', 'cm', 'pc', 'pu', 'lb']) {
          if (D.length && !near(sum(D, f), sum(S, f), 1)) fails.push(`${clock} ${g} Σ days ${f} ${sum(D, f)} ≠ Σ sources ${sum(S, f)}`);
          if (W.length && !near(sum(W, f), sum(A, f), 1)) fails.push(`${clock} ${g} Σ webmasters ${f} ${sum(W, f)} ≠ AlterCPA ${sum(A, f)}`);
        }
      }
    }
    for (const g of ['collected', 'returned']) {
      const P = (cohort.products ?? []).filter((p) => p.g === g);
      const S = (cohort.agg ?? []).filter((x) => x.dim === 's' && x.g === g);
      if (!near(sum(P, 'rev'), sum(S, 'rev'), 1 + P.length * 0.01)) fails.push(`${g} Σ products revenue ${sum(P, 'rev')} ≠ ${sum(S, 'rev')}`);
      if (!near(sum(P, 'cm'), sum(S, 'cm'), 1 + P.length * 0.01)) fails.push(`${g} Σ products cost ${sum(P, 'cm')} ≠ ${sum(S, 'cm')}`);
    }
    check('P5', 'Σ days = Σ sources = Σ webmasters (AlterCPA) = Σ products', fails);
  }

  // P6 — the api's P&L
  const mex = rates.find((r) => r.service === 'door') ?? rates[0];
  const settings = {
    vatRate: VAT_RATE,
    deliverEur: n(mex?.deliver_cost), returnEur: n(mex?.return_cost), rateSource: mex ? 'courier_rates' : 'fallback',
    agentNames: IP.commissionAgentNames(people[0].profiles ?? [], people[0].roles ?? []),
  };
  const resp = IP.buildProfitResponse({ cohort, cash }, w, settings, now);
  {
    const fails = [];
    const deliver = Math.round(settings.deliverEur * 61.5);
    for (const clock of ['cohort', 'cash']) {
      const c = resp[clock];
      for (const f of ['sales', 'revenue_mkd', 'vat_mkd', 'cogs_known_mkd', 'courier_mkd', 'returns_mkd', 'commission_mkd', 'net_mkd']) {
        if (!near(sum(c.by_source, f), c.total[f], 4)) fails.push(`${clock} Σ sources ${f} ${sum(c.by_source, f)} ≠ total ${c.total[f]}`);
      }
      const t = c.total;
      if (!near(t.vat_mkd, t.revenue_mkd * VAT_RATE / (1 + VAT_RATE), 1)) fails.push(`${clock} VAT ${t.vat_mkd}`);
      if (!near(t.courier_mkd, t.parcels_delivered * deliver, 1)) fails.push(`${clock} courier ${t.courier_mkd} ≠ ${t.parcels_delivered} × ${deliver}`);
      const costs = t.vat_mkd + t.cogs_known_mkd + (t.cogs_est_mkd ?? 0) + t.courier_mkd + t.returns_mkd + t.commission_mkd + t.lead_cost_mkd;
      if (!near(t.revenue_mkd - costs, t.net_mkd, 4)) fails.push(`${clock} net ${t.net_mkd} ≠ revenue − costs ${t.revenue_mkd - costs}`);
    }
    const prodComm = sum(resp.products, 'commission_mkd') + n(resp.products_others?.commission_mkd);
    if (!near(prodComm, resp.cohort.total.commission_mkd, 2 + resp.products.length * 0.5)) fails.push(`Σ product commission ${prodComm} ≠ ${resp.cohort.total.commission_mkd}`);
    const prodRev = sum(resp.products, 'revenue_mkd') + n(resp.products_others?.revenue_mkd);
    if (!near(prodRev, resp.cohort.total.revenue_mkd, 2 + resp.products.length * 0.5)) fails.push(`Σ product revenue ${prodRev} ≠ ${resp.cohort.total.revenue_mkd}`);
    check('P6', "the api's P&L adds up (sources, VAT, courier, net, products)", fails);
  }

  return { w, live, resp, results };
}

export function headline(resp) {
  const line = (c) => ({
    sales: c.total.sales, revenue: c.total.revenue_mkd, vat: c.total.vat_mkd, cogs_known: c.total.cogs_known_mkd,
    cogs_est: c.total.cogs_est_mkd, courier: c.total.courier_mkd, returns: c.total.returns_mkd,
    commission: c.total.commission_mkd, net: c.total.net_mkd, margin: c.total.margin, net_upper: c.total.net_upper_mkd,
    coverage_packages: c.total.coverage_packages, cost_ratio: c.cost_ratio,
    by_source: Object.fromEntries(c.by_source.map((r) => [r.key, { sales: r.sales, revenue: r.revenue_mkd, net: r.net_mkd, margin: r.margin }])),
  });
  return { cohort: line(resp.cohort), cash: line(resp.cash), strip_total: resp.strip.total };
}

const USAGE = `usage: node scripts/verify-tab-profit.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
Read-only. Dates are Skopje calendar days (inclusive; default the 7 days ending today).
Exit 1 if any check FAILs, 2 if refused / unreachable.`;

function parseArgs(argv) {
  const opts = { json: false, from: null, to: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === '--json' && val === undefined) opts.json = true;
    else if ((arg === '--help' || arg === '-h') && val === undefined) opts.help = true;
    else if (arg === '--from' || arg === '--to') {
      if (val === undefined) val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = val;
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  for (const k of ['from', 'to']) {
    if (opts[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new UsageError(`--${k} must be YYYY-MM-DD`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return EXIT.OK; }
  const t0 = Date.now();
  const { w, live, resp, results } = await verify({ from: opts.from, to: opts.to, sql: runSql });
  const exitCode = results.some((r) => r.status === 'FAIL') ? EXIT.FAIL : EXIT.OK;
  if (opts.json) {
    console.log(JSON.stringify({ tool: 'verify-tab-profit', read_only: true, window: { from: w.from, to: w.to },
      source: live ? 'insights_profit()' : 'migration text', exit_code: exitCode, headline: headline(resp), results }, null, 2));
  } else {
    console.log(`verify-tab-profit ${w.from} → ${w.to} (Skopje) · ${live ? 'insights_profit()' : 'the migration\'s query text (not applied yet)'} · ${Date.now() - t0} ms`);
    for (const r of results) {
      console.log(`  ${r.status === 'PASS' ? 'PASS' : 'FAIL'}  ${r.id}  ${r.title}${r.info.length ? `  (${r.info.join('; ')})` : ''}`);
      for (const f of r.fails.slice(0, 12)) console.log(`        ✗ ${f}`);
    }
    const h = headline(resp);
    for (const k of ['cohort', 'cash']) {
      const c = h[k];
      console.log(`  H  ${k.padEnd(6)} sales ${c.sales} · revenue ${c.revenue} · VAT ${c.vat} · COGS ${c.cogs_known} + est ${c.cogs_est ?? '—'} · courier ${c.courier} · returns ${c.returns} · commission ${c.commission} → net ${c.net} (${c.margin == null ? '—' : (c.margin * 100).toFixed(1) + '%'}; uncosted at 0: ${c.net_upper}) · coverage ${c.coverage_packages == null ? '—' : (c.coverage_packages * 100).toFixed(1) + '%'}`);
    }
    console.log(exitCode ? 'RESULT: FAIL' : 'RESULT: all checks pass');
  }
  return exitCode;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* keep */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
}

if (invokedAsCli()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`verify-tab-profit ${e instanceof UsageError ? 'usage' : 'error'}: ${e?.message ?? e}`);
    process.exitCode = EXIT.ERROR;
  });
}
