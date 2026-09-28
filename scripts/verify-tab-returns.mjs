/**
 * verify-tab-returns — READ-ONLY proof that Insights → Враќања and Производи и
 * залихи (migration 20260941000500: insights_returns / insights_stock /
 * insights_parcel_rows, GET /api/insights/returns and /api/insights/stock) tie
 * out, for the same windows and sources.
 *
 *   node scripts/verify-tab-returns.mjs                          (22–28.09.2026 and 01–27.09.2026)
 *   node scripts/verify-tab-returns.mjs --from 2026-09-01 --to 2026-09-27
 *   node scripts/verify-tab-returns.mjs --year                   (+ a one-year timing run)
 *   node scripts/verify-tab-returns.mjs --json
 *
 * Before the migration is applied it runs the functions' bodies straight out
 * of the migration file (plain read-only SELECTs, parameters inlined,
 * insights_parcel_rows inlined as a subquery), so the file itself is what is
 * proven. Timings are then indicative only (the functions pin work_mem / jit).
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB unreachable.
 *
 * What it proves, per window (Skopje days, the api's own insightsWindows()):
 *   R1  cohort clock = THE cohort (insights_cohort): per source, the returned part
 *       (count, денари) and the sales; the KPIs; cancelled / trashed after the sale
 *   R2  MEX clock: returned = the MEX register (status 7, returned in the window,
 *       less the test phones) — count and COD
 *   R3  MEX clock: delivered part = insights_cash_rows for the window, per source
 *   R4  each payload adds up: Σ sources = KPIs, Σ splits = source, Σ weekday =
 *       base, Σ day bins = count, Σ trend = KPIs
 *   R5  a non-owner payload (p_money = false) carries no *_mkd key (applied only)
 *   S1  stock: sales = the cohort's, returned parcels = the register's, the queue
 *       adds up (ages, sources) and to-pack orders = the cohort's to_pack orders now
 *   S2  stock: no valuation while the count is untrusted
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) —
 * pinned to Macedonia (bmfxhgznttcnnlqloqzp), refused if .env points at
 * Bulgaria, every statement a single SELECT/WITH sent with read_only: true.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTwin, runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000500_insights_returns_stock.sql');
const SIG_RETURNS = 'public.insights_returns(timestamptz,timestamptz,text,timestamptz,timestamptz,text[],boolean)';
const DEFAULT_WINDOWS = [['2026-09-22', '2026-09-28'], ['2026-09-01', '2026-09-27']];
// the five sources in the owner's order (migration 20260942000500)
const SOURCES = ['altercpa', 'elyon_crm', 'teleshop_other', 'social', 'web'];
const EXCLUDED = '(SELECT public.report_excluded_phone8s())::text[]';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const sum = (list, f) => (list ?? []).reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x?.[f]), 0);
const tie = (label, want, got) => ({ label, want: n(want), got: n(got), ok: n(want) === n(got) });
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const ts = (iso) => (iso ? `${lit(iso)}::timestamptz` : 'NULL::timestamptz');
const arr = (xs) => `ARRAY[${xs.map(lit).join(',')}]::text[]`;
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function args(argv) {
  const out = { windows: [], json: false, year: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--year') out.year = true;
    else if (a === '--from') out.from = argv[++i];
    else if (a === '--to') out.to = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  if (out.from || out.to) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.from ?? '') || !/^\d{4}-\d{2}-\d{2}$/.test(out.to ?? '')) throw new Error('--from and --to are YYYY-MM-DD');
    out.windows = [[out.from, out.to]];
  } else out.windows = DEFAULT_WINDOWS;
  return out;
}

// ── the bodies out of the migration (before it is applied) ───────────────────
const mig = readFileSync(MIGRATION, 'utf8');
function body(tag) {
  const a = mig.indexOf(`$${tag}$\n`);
  const b = mig.indexOf(`\n  $${tag}$`, a + 5);
  if (a < 0 || b < 0) throw new Error(`no $${tag}$ body in the migration`);
  return mig.slice(a + tag.length + 3, b);
}
const sub = (s, ps) => { let t = s; for (let i = ps.length; i >= 1; i--) t = t.split(`$${i}`).join(ps[i - 1]); return t; };
function inline(sql) {
  const pr = body('pr');
  return sql.replace(/public\.insights_parcel_rows\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g, (_, a) => {
    const [x, y, z] = a.split(/,(?![^(]*\))/).map((s) => s.trim());
    return `(${sub(pr, [x, y, z, EXCLUDED])})`;
  });
}

async function timed(sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  return { rows, ms: Date.now() - t0 };
}

async function callReturns(applied, w, clock, money = true) {
  const prev = w.prev && w.days <= 93 ? w.prev : null;
  if (applied) {
    return timed(`SELECT public.insights_returns(${ts(w.fromIso)}, ${ts(w.toEndIso)}, ${lit(clock)}, ${ts(prev?.fromIso)}, ${ts(prev?.toEndIso)}, ${arr(SOURCES)}, ${money})::text AS j`);
  }
  const lo = prev ? prev.fromIso : w.fromIso;
  const gran = w.days <= 62 ? 'day' : 'month';
  const p = [ts(w.fromIso), ts(w.toEndIso), ts(prev?.fromIso), ts(prev?.toEndIso), arr(SOURCES), ts(lo),
    `${lit(w.from)}::date`, `${lit(w.to)}::date`, lit(gran), lit(clock),
    "(SELECT max(r.return_cost) FROM public.courier_rates r WHERE r.courier = 'mex')",
    "(SELECT max(r.deliver_cost) FROM public.courier_rates r WHERE r.courier = 'mex')", EXCLUDED];
  return timed(`SELECT (${inline(sub(body('rs'), p))})::text AS j`);
}

async function callStock(applied, w) {
  const prev = w.prev && w.days <= 93 ? w.prev : null;
  if (applied) {
    return timed(`SELECT public.insights_stock(${ts(w.fromIso)}, ${ts(w.toEndIso)}, ${ts(prev?.fromIso)}, ${ts(prev?.toEndIso)}, ${arr(SOURCES)}, true)::text AS j`);
  }
  const lo = prev ? prev.fromIso : w.fromIso;
  const gran = w.days <= 62 ? 'day' : 'month';
  const p = [ts(w.fromIso), ts(w.toEndIso), ts(prev?.fromIso), ts(prev?.toEndIso), arr(SOURCES), ts(lo),
    `${lit(w.from)}::date`, `${lit(w.to)}::date`, lit(gran), EXCLUDED, "(now() AT TIME ZONE 'Europe/Skopje')::date"];
  return timed(`SELECT (${inline(sub(body('st'), p))})::text AS j`);
}

const bucketOf = (list, key) => (list ?? []).find((b) => b.key === key) ?? {};

function internal(label, p) {
  const k = p.kpis;
  const out = [
    tie(`${label} Σ sources base = KPI base`, k.base.count, sum(p.by_source, 'base')),
    tie(`${label} Σ sources returned = KPI returned`, k.returned.count, sum(p.by_source, 'returned')),
    tie(`${label} returned = orders + web + MEX-only`, k.returned.count, n(k.returned.orders) + n(k.returned.web) + n(k.returned.mex_only)),
    tie(`${label} Σ weekday base = KPI base`, k.base.count, sum(p.by_weekday, 'base')),
    tie(`${label} Σ day bins = days_to_return.count`, p.days_to_return.count, sum(p.days_to_return.bins, 'count')),
    tie(`${label} Σ trend base = KPI base`, k.base.count, sum(p.trend, 'base')),
    tie(`${label} Σ trend returned = KPI returned`, k.returned.count, sum(p.trend, 'returned')),
  ];
  for (const s of p.by_source) out.push(tie(`${label} ${s.key}: Σ splits = source base`, s.base, sum(s.splits, 'base')));
  return out;
}

async function verifyWindow(IC, applied, from, to, now) {
  const w = IC.insightsWindows(from, to, true, now);
  if ('error' in w) throw new Error(w.error);
  const checks = [];
  const timings = {};

  // R1 — the cohort clock against THE cohort
  const [sale, cohortRows] = await Promise.all([
    callReturns(applied, w, 'sale'),
    runSql(`SELECT public.insights_cohort(${ts(w.fromIso)}, ${ts(w.toEndIso)}, NULL, NULL, ${arr(SOURCES)}, true)::text AS j`),
  ]);
  timings.returns_sale_ms = sale.ms;
  const rs = parse(sale.rows[0].j);
  const co = parse(cohortRows[0].j);
  checks.push(tie('R1 sales = cohort total', co.total.count, rs.kpis.base.count));
  checks.push(tie('R1 returned = cohort returned', bucketOf(co.buckets, 'returned').count, rs.kpis.returned.count));
  checks.push(tie('R1 returned денари = cohort returned', bucketOf(co.buckets, 'returned').value_mkd, rs.kpis.returned.value_mkd));
  checks.push(tie('R1 cancelled after sale = cohort', bucketOf(co.outside, 'cancelled_after_sale').count, rs.kpis.cancelled_after_sale.count));
  checks.push(tie('R1 trashed after sale = cohort', bucketOf(co.outside, 'trashed_after_sale').count, rs.kpis.trashed_after_sale.count));
  for (const src of co.by_source) {
    const mine = rs.by_source.find((x) => x.key === src.key) ?? {};
    checks.push(tie(`R1 ${src.key}: sales`, src.total.count, mine.base));
    checks.push(tie(`R1 ${src.key}: returned`, bucketOf(src.buckets, 'returned').count, mine.returned));
    checks.push(tie(`R1 ${src.key}: returned денари`, bucketOf(src.buckets, 'returned').value_mkd, mine.value_mkd));
  }
  checks.push(...internal('R4 sale', rs));

  // R2 / R3 — the MEX clock against the register and the cash rows
  const [mex, reg, cash] = await Promise.all([
    callReturns(applied, w, 'returned'),
    runSql(`SELECT count(*)::int AS n, coalesce(sum(p.cod_mkd), 0)::bigint AS cod FROM public.mex_parcels p
             WHERE p.status_id = 7 AND p.returned_at BETWEEN ${ts(w.fromIso)} AND ${ts(w.toEndIso)}
               AND NOT coalesce(p.phone8 = ANY (public.report_excluded_phone8s()), false)`),
    runSql(`SELECT c.source, count(*)::int AS n FROM public.insights_cash_rows(${ts(w.fromIso)}, ${ts(w.toEndIso)}) c GROUP BY 1`),
  ]);
  timings.returns_mex_ms = mex.ms;
  const rm = parse(mex.rows[0].j);
  checks.push(tie('R2 returned = MEX register (status 7 in the window)', reg[0].n, rm.kpis.returned.count));
  checks.push(tie('R2 returned COD = MEX register', reg[0].cod, rm.kpis.returned.cod_mkd));
  checks.push(tie('R3 delivered = insights_cash_rows', sum(cash, 'n'), rm.kpis.base.count - rm.kpis.returned.count));
  for (const c of cash) {
    const mine = rm.by_source.find((x) => x.key === c.source) ?? {};
    checks.push(tie(`R3 ${c.source}: delivered = cash rows`, c.n, n(mine.base) - n(mine.returned)));
  }
  checks.push(...internal('R4 MEX', rm));

  // R5 — the non-owner payload (only the applied function strips)
  if (applied) {
    const nm = parse((await callReturns(applied, w, 'sale', false)).rows[0].j);
    const moneyKeys = JSON.stringify(nm).match(/"[a-z_]+_(mkd|eur)"/g) ?? [];
    checks.push({ label: 'R5 non-owner payload has no *_mkd key', want: 0, got: moneyKeys.length, ok: moneyKeys.length === 0 });
  }

  // S1 / S2 — stock
  const [stock, toPack] = await Promise.all([
    callStock(applied, w),
    runSql(`SELECT count(*)::int AS n FROM public.orders x
             WHERE x.status = 'confirmed' AND x.sale_source_detail IS DISTINCT FROM 'disposition'
               AND public.cohort_order_bucket(x.status::text, x.price, x.sold_at, x.paid_basis, x.source_type, x.sale_source_detail,
                     x.mex_tracking_id, x.mex_status_id, x.mex_cod_mkd, x.mex_delivered_at,
                     coalesce(x.mex_tracking_id IN (SELECT wo.mex_tracking_id FROM public.web_orders wo
                                                     WHERE wo.mex_tracking_id IS NOT NULL AND wo.deleted_in_shop_at IS NULL), false)) = 'to_pack'
               AND NOT coalesce(public.insights_phone8(x.customer_phone) = ANY (public.report_excluded_phone8s()), false)`),
  ]);
  timings.stock_ms = stock.ms;
  const st = parse(stock.rows[0].j);
  checks.push(tie('S1 stock sales = cohort total', co.total.count, st.kpis.sales));
  checks.push(tie('S1 stock returned parcels = MEX register', reg[0].n, st.kpis.returned_parcels));
  for (const q of st.queue) {
    checks.push(tie(`S1 queue ${q.stage}: Σ ages = count`, q.count, sum(q.ages, 'count')));
    checks.push(tie(`S1 queue ${q.stage}: Σ sources = count`, q.count, sum(q.by_source, 'count')));
    checks.push(tie(`S1 queue ${q.stage}: orders + web + MEX-only = count`, q.count, n(q.orders) + n(q.web) + n(q.mex_only)));
  }
  const pack = st.queue.find((q) => q.stage === 'to_pack');
  checks.push(tie('S1 to-pack orders = the cohort\'s to_pack orders now', toPack[0].n, pack?.orders));
  checks.push({ label: 'S2 no valuation while untrusted', want: 'null', got: st.trust.trusted ? 'trusted' : String(st.valuation ?? null),
    ok: st.trust.trusted || st.valuation == null });

  const headline = {
    sale: { sales: rs.kpis.base.count, returned: rs.kpis.returned.count, value_mkd: rs.kpis.returned.value_mkd, rate: rs.kpis.rate,
      open_share: rs.kpis.open?.share, by_source: Object.fromEntries(rs.by_source.map((s) => [s.key, `${s.returned}/${s.base}`])) },
    mex: { finished: rm.kpis.base.count, returned: rm.kpis.returned.count, cod_mkd: rm.kpis.returned.cod_mkd, rate: rm.kpis.rate,
      by_source: Object.fromEntries(rm.by_source.map((s) => [s.key, s.returned])) },
    stock: { units: st.kpis.units, to_pack: pack?.count, label: st.queue.find((q) => q.stage === 'label')?.count, trusted: st.trust.trusted,
      parcels_since_deduction: st.trust.parcels_since_deduction },
  };
  return { from: w.from, to: w.to, applied, timings, headline, checks };
}

async function main() {
  let opts;
  try { opts = args(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  const IC = await loadTwin();
  const now = new Date();
  const probe = await runSql(`SELECT to_regprocedure(${lit(SIG_RETURNS)}) IS NOT NULL AS ok`);
  const applied = probe[0].ok === true;
  const results = [];
  for (const [from, to] of opts.windows) results.push(await verifyWindow(IC, applied, from, to, now));
  if (opts.year) {
    const today = IC.insightsWindows(null, null, false, now);
    const to = today.to;
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - 364 * 86400e3).toISOString().slice(0, 10);
    const w = IC.insightsWindows(from, to, false, now);
    const [a, b, c] = [await callReturns(applied, w, 'sale'), await callReturns(applied, w, 'returned'), await callStock(applied, w)];
    results.push({ from, to, applied, timings: { returns_sale_ms: a.ms, returns_mex_ms: b.ms, stock_ms: c.ms }, headline: null, checks: [] });
  }
  const failed = results.flatMap((r) => r.checks).filter((c) => !c.ok);
  if (opts.json) {
    console.log(JSON.stringify({ applied, results, failed: failed.length }, null, 1));
  } else {
    console.log(`verify-tab-returns — ${applied ? 'the applied functions' : 'the migration bodies, inlined (not applied yet)'}`);
    for (const r of results) {
      console.log(`\n${r.from} … ${r.to}   timings ${JSON.stringify(r.timings)}`);
      if (r.headline) console.log(`  ${JSON.stringify(r.headline)}`);
      for (const c of r.checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.label}: want ${c.want} · got ${c.got}`);
    }
    console.log(`\n${failed.length ? `${failed.length} FAIL` : 'all PASS'}`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
