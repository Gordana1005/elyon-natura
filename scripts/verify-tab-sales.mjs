/**
 * verify-tab-sales — READ-ONLY proof that Insights → Продажби (migration
 * 20260941000100 insights_sales, GET /api/insights/sales) ties to THE sale
 * cohort (insights_cohort, migration 20260940000000) for the same window.
 *
 *   node scripts/verify-tab-sales.mjs                         (22–28.09.2026 and 01–27.09.2026)
 *   node scripts/verify-tab-sales.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-tab-sales.mjs --json
 *
 * Before the migration is applied it runs the function's three bodies straight
 * out of the migration file (as plain read-only SELECTs, parameters inlined), so
 * the file itself is what is proven.
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB
 * unreachable.
 *
 * What it proves, per window (Skopje days, the api's own insightsWindows()):
 *   S1  core total / 8 buckets / 3 outside = the cohort's (count, денари, COD,
 *       orders · web · MEX-only · booked)
 *   S2  core by_source (total, buckets, splits) = the cohort's
 *   S3  the core payload adds up (Σ buckets = total, Σ sources = total, Σ splits)
 *   S4  trend: Σ points = total; each point's Σ sources = the point; Σ per source
 *   S5  MEX account × series: Σ = total (count, денари, COD); Σ per source
 *   S6  weekday × hour: cells + untimed = total; weekdays = total
 *   S7  quality: the cohort's five counts, equal
 *   S8  products: top + others = products; products + other lines + no line =
 *       the total value (to the denar); detail total = cohort total
 *   S9  cities: rows + others + unknown = the total (count and денари)
 *   S10 buyers: sales + no phone = total; new + returning = buyers; per source
 *   S11 basket: Σ distribution = total (count and денари); per source = source totals
 *   S12 previous period (summary part) = the cohort's prev (count, денари, buckets)
 *   S13 a non-owner payload (p_money = false) carries no *_mkd / *_eur key
 *
 * Safety: the same guard as scripts/verify-insights-ties.mjs (imported, not
 * copied) — pinned to Macedonia (oufoazmnbwugtfldkwsn), refused if .env points
 * at Bulgaria, every statement a single SELECT/WITH sent with read_only: true.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTwin, payloadTies, runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000100_insights_sales.sql');
const SIG = 'public.insights_sales(timestamptz,timestamptz,text,boolean,integer)';
const DEFAULT_WINDOWS = [['2026-09-22', '2026-09-28'], ['2026-09-01', '2026-09-27']];
const TOP = 40;

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const sum = (list, f) => (list ?? []).reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x?.[f]), 0);
const tie = (label, want, got) => ({ label, want, got, ok: want === got });
const statusOf = (lines) => (lines.some((l) => !l.ok) ? 'FAIL' : 'PASS');
const tsLit = (iso) => `'${iso}'::timestamptz`;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

/** The trend granularity the function picks (day ≤ 62 · week ≤ 190 · month). */
export function granOf(fromDay, toDay) {
  const days = Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000) + 1;
  return days <= 62 ? 'day' : days <= 190 ? 'week' : 'month';
}

/** One of the function's bodies, out of the migration file, parameters inlined. */
export function bodyFromMigration(text, part, p) {
  const m = text.match(new RegExp(`EXECUTE \\$${part}\\$\\r?\\n([\\s\\S]*?)\\$${part}\\$`));
  if (!m) throw new Error(`the ${part} body is not in ${MIGRATION}`);
  const vals = {
    1: tsLit(p.fromIso), 2: tsLit(p.toEndIso), 3: `'${p.from}'::date`, 4: `'${p.to}'::date`,
    5: `'${p.gran}'::text`, 6: `${p.top}::integer`, 7: `${p.money ? 'true' : 'false'}::boolean`,
  };
  return m[1].replace(/\$(\d+)(::[a-z]+)?/g, (all, k) => vals[k] ?? all);
}

async function salesPart(ctx, part, win, money) {
  const p = { fromIso: win.fromIso, toEndIso: win.toEndIso, from: win.from, to: win.to, gran: granOf(win.from, win.to), top: TOP, money };
  const t0 = Date.now();
  let body;
  if (ctx.live) {
    const [r] = await runSql(`SELECT public.insights_sales(${tsLit(p.fromIso)}, ${tsLit(p.toEndIso)}, '${part}', ${money}, ${TOP}) AS j`);
    body = parseJson(r.j);
  } else {
    const inner = bodyFromMigration(ctx.migration, part, p);
    const sql = money ? inner : `SELECT public.insights_strip_money((${inner}))`;
    const rows = await runSql(sql);
    body = parseJson(Object.values(rows[0])[0]);
    if (!money) body = { ...body, meta: { ...body.meta, money: false } };
  }
  ctx.timings.push({ part, window: `${win.from}..${win.to}`, money, ms: Date.now() - t0 });
  return body;
}

// booked = collabBox bookings awaiting their parcel (20260942001900); absent on both sides before it
const PART = ['count', 'value_mkd', 'cod_mkd', 'orders', 'web', 'mex_only', 'booked'];

function eqParts(lines, label, want, got, fields = PART) {
  for (const f of fields) {
    if (want?.[f] === undefined && got?.[f] === undefined) continue;
    lines.push(tie(`${label}.${f}`, n(want?.[f]), n(got?.[f])));
  }
}

export function coreTies(cohort, core) {
  const S1 = [], S2 = [], S3 = [], S4 = [], S5 = [], S6 = [], S7 = [];
  eqParts(S1, 'total', cohort.total, core.total);
  for (const list of ['buckets', 'outside']) {
    for (const b of cohort[list] ?? []) eqParts(S1, `${list}.${b.key}`, b, (core[list] ?? []).find((x) => x.key === b.key));
    S1.push(tie(`${list}: same keys`, (cohort[list] ?? []).map((b) => b.key).join(','), (core[list] ?? []).map((b) => b.key).join(',')));
  }
  for (const r of cohort.by_source ?? []) {
    const s = (core.by_source ?? []).find((x) => x.key === r.key);
    eqParts(S2, `${r.key}.total`, r.total, s?.total);
    for (const b of r.buckets ?? []) eqParts(S2, `${r.key}.${b.key}`, b, (s?.buckets ?? []).find((x) => x.key === b.key), ['count', 'value_mkd', 'cod_mkd']);
    for (const sp of r.splits ?? []) {
      const g = (s?.splits ?? []).find((x) => x.key === sp.key && x.kind === sp.kind);
      eqParts(S2, `${r.key}.split.${sp.kind}:${sp.key}`, sp, g, ['count', 'value_mkd']);
      S2.push(tie(`${r.key}.split.${sp.key}.drill`, sp.drill ?? null, g?.drill ?? null));
    }
  }
  const self = payloadTies({ ...core, leads_in: null });
  S3.push(...self.T1, ...self.T2, ...self.T3);

  const pts = core.trend?.points ?? [];
  S4.push(tie('Σ trend.count = total.count', n(core.total?.count), sum(pts, 'count')));
  if (core.total?.value_mkd !== undefined) S4.push(tie('Σ trend.value_mkd = total.value_mkd', n(core.total.value_mkd), sum(pts, 'value_mkd')));
  for (const p of pts) {
    S4.push(tie(`${p.d}: Σ sources.count = count`, n(p.count), sum(p.by_source, 'count')));
    if (p.value_mkd !== undefined) S4.push(tie(`${p.d}: Σ sources.value_mkd = value_mkd`, n(p.value_mkd), sum(p.by_source, 'value_mkd')));
  }
  for (const r of core.by_source ?? []) {
    S4.push(tie(`trend Σ ${r.key}.count = its total`, n(r.total?.count), sum(pts, (p) => (p.by_source ?? []).find((x) => x.key === r.key)?.count)));
  }

  const ch = core.channels ?? [];
  S5.push(tie('Σ channels.count = total.count', n(core.total?.count), sum(ch, 'count')));
  if (core.total?.value_mkd !== undefined) {
    S5.push(tie('Σ channels.value_mkd = total.value_mkd', n(core.total.value_mkd), sum(ch, 'value_mkd')));
    S5.push(tie('Σ channels.cod_mkd = total.cod_mkd', n(core.total.cod_mkd), sum(ch, 'cod_mkd')));
  }
  for (const c of ch) S5.push(tie(`${c.account ?? '-'}/${c.series}: Σ sources = count`, n(c.count), sum(c.by_source, 'count')));
  for (const r of core.by_source ?? []) {
    S5.push(tie(`channels Σ ${r.key} = its total`, n(r.total?.count), sum(ch, (c) => (c.by_source ?? []).find((x) => x.key === r.key)?.count)));
  }

  const tm = core.timing ?? {};
  S6.push(tie('Σ cells = timed', n(tm.timed), sum(tm.cells, 'count')));
  S6.push(tie('timed + untimed = total.count', n(core.total?.count), n(tm.timed) + sum(tm.untimed, 'count')));
  S6.push(tie('Σ weekdays = total.count', n(core.total?.count), sum(tm.weekdays, 'count')));

  for (const q of cohort.quality ?? []) {
    const g = (core.quality ?? []).find((x) => x.kind === q.kind);
    eqParts(S7, `quality.${q.kind}`, q, g, ['count', 'value_mkd']);
  }
  return { S1, S2, S3, S4, S5, S6, S7 };
}

export function detailTies(cohort, d) {
  const S8 = [], S9 = [], S10 = [], S11 = [];
  const T = cohort.total ?? {};
  const money = T.value_mkd !== undefined;
  S8.push(tie('detail total.count = cohort total.count', n(T.count), n(d.total?.count)));
  if (money) S8.push(tie('detail total.value_mkd = cohort total.value_mkd', n(T.value_mkd), n(d.total?.value_mkd)));
  const p = d.products ?? {};
  if (money) {
    S8.push(tie('Σ top products + others = products value', n(p.summary?.value_mkd), sum(p.rows, 'value_mkd') + n(p.others?.value_mkd)));
    S8.push(tie('products + other lines + no line = total value', n(T.value_mkd),
      n(p.summary?.value_mkd) + sum(p.non_product, 'value_mkd') + n(p.no_product?.value_mkd)));
  }
  S8.push(tie('Σ top units + others = products units', n(p.summary?.units), sum(p.rows, 'units') + n(p.others?.units)));
  S8.push(tie('products: top + others = product count', n(p.summary?.products), (p.rows ?? []).length + n(p.others?.products)));
  for (const r of p.rows ?? []) {
    S8.push(tie(`${r.name}: Σ sources.units = units`, n(r.units), sum(r.by_source, 'units')));
    S8.push(tie(`${r.name}: Σ sources.sales = sales`, n(r.sales), sum(r.by_source, 'sales')));
  }

  const c = d.cities ?? {};
  S9.push(tie('cities: rows + others + unknown = total.count', n(T.count), sum(c.rows, 'count') + n(c.others?.count) + n(c.unknown?.count)));
  if (money) S9.push(tie('cities: rows + others + unknown = total.value_mkd', n(T.value_mkd), sum(c.rows, 'value_mkd') + n(c.others?.value_mkd) + n(c.unknown?.value_mkd)));
  S9.push(tie('cities: rows + others = places', n(c.places), (c.rows ?? []).length + n(c.others?.places)));

  const b = d.customers ?? {};
  S10.push(tie('buyers: sales + no phone = total.count', n(T.count), n(b.sales) + n(b.no_phone)));
  S10.push(tie('buyers: new + returning = buyers', n(b.buyers), n(b.new) + n(b.returning)));
  S10.push(tie('buyers: sales_new + sales_returning = sales', n(b.sales), n(b.sales_new) + n(b.sales_returning)));
  for (const s of b.by_source ?? []) S10.push(tie(`${s.key}: new + returning = buyers`, n(s.buyers), n(s.new) + n(s.returning)));

  const k = d.basket ?? {};
  S11.push(tie('basket: Σ dist.count = total.count', n(T.count), sum(k.dist, 'count')));
  if (money) S11.push(tie('basket: Σ dist.value_mkd = total.value_mkd', n(T.value_mkd), sum(k.dist, 'value_mkd')));
  for (const s of k.by_source ?? []) {
    const src = (cohort.by_source ?? []).find((x) => x.key === s.key);
    S11.push(tie(`basket ${s.key}.count = its total`, n(src?.total?.count), n(s.count)));
    S11.push(tie(`basket ${s.key}: Σ dist = count`, n(s.count), sum(s.dist, 'count')));
  }
  return { S8, S9, S10, S11 };
}

export function prevTies(cohort, summary) {
  const S12 = [];
  if (!cohort.prev) return S12;
  eqParts(S12, 'prev.total', cohort.prev.total, summary.total, ['count', 'value_mkd', 'cod_mkd']);
  for (const b of cohort.prev.buckets ?? []) eqParts(S12, `prev.${b.key}`, b, (summary.buckets ?? []).find((x) => x.key === b.key), ['count', 'value_mkd', 'cod_mkd']);
  S12.push(tie('prev: Σ by_source = total', n(summary.total?.count), sum(summary.by_source, (s) => s.total?.count)));
  return S12;
}

export function moneyKeys(v, path = '') {
  if (Array.isArray(v)) return v.flatMap((x, i) => moneyKeys(x, `${path}[${i}]`));
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([k, x]) => [...(/(_mkd|_eur)$/.test(k) ? [`${path}.${k}`] : []), ...moneyKeys(x, `${path}.${k}`)]);
  }
  return [];
}

async function verifyWindow(ctx, from, to) {
  const w = ctx.IC.insightsWindows(from, to, true);
  if ('error' in w) throw new Error(w.error);
  const [c] = await runSql(`SELECT public.insights_cohort(${tsLit(w.fromIso)}, ${tsLit(w.toEndIso)}, ${w.prev ? tsLit(w.prev.fromIso) : 'NULL'}, ${w.prev ? tsLit(w.prev.toEndIso) : 'NULL'}, NULL::text[], true) AS cohort`);
  const cohort = parseJson(c.cohort);
  const core = await salesPart(ctx, 'core', w, true);
  const detail = await salesPart(ctx, 'detail', w, true);
  const summary = w.prev ? await salesPart(ctx, 'summary', w.prev, true) : null;
  const coreNoMoney = await salesPart(ctx, 'core', w, false);
  const detailNoMoney = await salesPart(ctx, 'detail', w, false);

  const ties = { ...coreTies(cohort, core), ...detailTies(cohort, detail), S12: summary ? prevTies(cohort, summary) : [] };
  const leaked = [...moneyKeys(coreNoMoney), ...moneyKeys(detailNoMoney)];
  ties.S13 = [tie('no *_mkd / *_eur key in the non-owner payload', 0, leaked.length)];
  const TITLES = {
    S1: 'core total / buckets / outside = the cohort', S2: 'core by_source (total, buckets, splits) = the cohort',
    S3: 'the core payload adds up', S4: 'trend adds up (points, sources)', S5: 'MEX account × series adds up',
    S6: 'weekday × hour: cells + untimed = total', S7: 'quality counts = the cohort', S8: 'products: value spread to the denar',
    S9: 'cities add up (rows + others + unknown)', S10: 'buyers add up', S11: 'basket adds up', S12: 'previous period = the cohort prev',
    S13: 'non-owner payload has no money',
  };
  const results = Object.entries(ties).map(([id, lines]) => ({ id, title: TITLES[id], status: statusOf(lines), lines }));
  const head = {
    window: `${w.from} .. ${w.to}`,
    total: core.total, prev: summary?.total ?? null,
    by_source: (core.by_source ?? []).map((s) => ({ key: s.key, count: s.total?.count, value_mkd: s.total?.value_mkd })),
    products: detail.products?.summary, non_product: detail.products?.non_product, no_product: detail.products?.no_product,
    cities: { places: detail.cities?.places, spellings: detail.cities?.spellings, unknown_places: detail.cities?.unknown_places },
    customers: detail.customers && { buyers: detail.customers.buyers, new: detail.customers.new, returning: detail.customers.returning, repeat: detail.customers.repeat, history_from: detail.customers.history_from },
    leaked: leaked.slice(0, 5),
  };
  return { w, results, head };
}

async function main(argv) {
  const json = argv.includes('--json');
  const get = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const from = get('--from'), to = get('--to');
  for (const [k, v] of [['--from', from], ['--to', to]]) if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw new Error(`${k} must be YYYY-MM-DD`);
  const windows = from && to ? [[from, to]] : DEFAULT_WINDOWS;
  const IC = await loadTwin();
  const [probe] = await runSql(`SELECT to_regprocedure('${SIG}') IS NOT NULL AS live`);
  const ctx = { IC, live: probe.live === true, migration: readFileSync(MIGRATION, 'utf8'), timings: [] };
  const out = [];
  for (const [f, t] of windows) out.push(await verifyWindow(ctx, f, t));
  const fail = out.some((o) => o.results.some((r) => r.status === 'FAIL'));
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-tab-sales', mode: ctx.live ? 'function' : 'migration-body', exit_code: fail ? 1 : 0, windows: out, timings: ctx.timings }, null, 2));
  } else {
    console.log(`verify-tab-sales | Macedonia | read-only | ${ctx.live ? 'live function public.insights_sales' : 'bodies from the migration file (function not applied yet)'}`);
    for (const o of out) {
      console.log(`\nwindow ${o.head.window}  total ${JSON.stringify(o.head.total)}  prev ${JSON.stringify(o.head.prev)}`);
      console.log(`  by source ${o.head.by_source.map((s) => `${s.key} ${s.count}${s.value_mkd !== undefined ? ` · ${s.value_mkd}` : ''}`).join(' | ')}`);
      console.log(`  products ${JSON.stringify(o.head.products)}`);
      console.log(`  other lines ${JSON.stringify(o.head.non_product)}  no line ${JSON.stringify(o.head.no_product)}`);
      console.log(`  cities ${JSON.stringify(o.head.cities)}  buyers ${JSON.stringify(o.head.customers)}`);
      for (const r of o.results) {
        const bad = r.lines.filter((l) => !l.ok);
        console.log(`  ${r.id.padEnd(4)} ${r.status.padEnd(5)} ${r.title} (${r.lines.length} ties)`);
        for (const l of bad.slice(0, 15)) console.log(`       ✗ ${l.label}: want ${l.want} got ${l.got}`);
      }
    }
    console.log(`\ntimings ${ctx.timings.map((x) => `${x.part}${x.money ? '' : '(no money)'} ${x.window} ${x.ms} ms`).join(' · ')}`);
    console.log(`exit ${fail ? 1 : 0}`);
  }
  return fail ? 1 : 0;
}

const isCli = !!process.argv[1] && resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isCli) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`verify-tab-sales error: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
}
