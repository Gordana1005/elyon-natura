/**
 * verify-tab-agents — READ-ONLY proof that Insights → Агенти (migration
 * 20260941000200 insights_people, GET /api/insights/agents) ties to THE sale
 * cohort (insights_cohort, migration 20260940000000) for the same window.
 *
 *   node scripts/verify-tab-agents.mjs                         (22–28.09.2026 and 01–27.09.2026)
 *   node scripts/verify-tab-agents.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-tab-agents.mjs --json
 *
 * Before the migration is applied it runs the function's body straight out of
 * the migration file (a plain read-only SELECT, parameters inlined), so the
 * file itself is what is proven ("mode: inline"); afterwards it calls the RPC.
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB
 * unreachable.
 *
 * What it proves, per window (Skopje days, the api's own insightsWindows()):
 *   A1  totals (count, денари, COD) and every source's total = the cohort's
 *   A2  Σ people's sales + sales with no seller = the cohort total, overall and
 *       per source; Σ people = totals.with_person
 *   A3  every person: Σ buckets = sales, Σ sources = sales; every team: Σ its
 *       members = the team (sales, worked); Σ teams = Σ people
 *   A4  every person's sales and buckets = an independent GROUP BY of
 *       insights_sale_rows (in_total, sold_by_person_id)
 *   A5  worked decisions = an independent recount of v_sales_work (test-phone
 *       orders excluded); Σ people.worked + decisions with no person = worked
 *   A6  the /orders twin: for the five biggest sellers, GET /orders?cohort_bucket=
 *       total&sold_by_person_id=…&sold_from&sold_to lists exactly their ORDER sales
 *       (their sales less their collabBox bookings awaiting a parcel, 20260942001900 —
 *       sales, not orders yet); for every team with drill_exact, …&team_key=… lists
 *       exactly the team's
 *   A7  compare: totals.prev.sales = the cohort's previous period total
 *   A8  the api's non-owner and agent payloads carry no *_mkd / *_eur key
 *   T   timings (server round trip, one-year window included: < 3 s target)
 *
 * Safety: the same guard as scripts/verify-insights-ties.mjs (imported, not
 * copied) — pinned to Macedonia (bmfxhgznttcnnlqloqzp), refused if .env points
 * at Bulgaria, every statement a single SELECT/WITH sent with read_only: true.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { drillPredicateParts, loadTwin, runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000200_insights_people.sql');
const SIG = 'public.insights_people(timestamptz,timestamptz,timestamptz,timestamptz,uuid)';
const DEFAULT_WINDOWS = [['2026-09-22', '2026-09-28'], ['2026-09-01', '2026-09-27']];
const YEAR_WINDOW = ['2025-09-28', '2026-09-27'];
const BUCKETS = ['paid', 'paid_legacy', 'paid_unproven', 'courier', 'courier_problem', 'label', 'to_pack', 'returned'];
// the six departments in the owner's order (migrations 20260942000500, 20260942001000)
const SOURCES = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'];

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const sum = (list, f) => (list ?? []).reduce((a, x) => a + n(typeof f === 'function' ? f(x) : x?.[f]), 0);
const tie = (label, want, got) => ({ label, want, got, ok: want === got });
const tsLit = (iso) => (iso ? `'${iso}'::timestamptz` : 'NULL::timestamptz');
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function loadTs(rel) {
  const file = join(ROOT, rel);
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    const esbuild = await import('esbuild');
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

/** The function's EXECUTE body, out of the migration file, parameters inlined. */
export function bodyFromMigration(text, p) {
  const m = text.match(/EXECUTE \$pp\$\r?\n([\s\S]*?)\r?\n\$pp\$/);
  if (!m) throw new Error(`the $pp$ body is not in ${MIGRATION}`);
  const days = Math.round((Date.parse(`${p.to}T00:00:00Z`) - Date.parse(`${p.from}T00:00:00Z`)) / 86_400_000) + 1;
  const lo = p.prev && Date.parse(p.prev.fromIso) < Date.parse(p.fromIso) ? p.prev.fromIso : p.fromIso;
  const vals = {
    1: tsLit(p.fromIso), 2: tsLit(p.toEndIso), 3: tsLit(p.prev?.fromIso), 4: tsLit(p.prev?.toEndIso),
    5: `'${p.from}'::date`, 6: `'${p.to}'::date`, 7: p.person ? `${q(p.person)}::uuid` : 'NULL::uuid',
    8: tsLit(lo), 9: "(now() AT TIME ZONE 'Europe/Skopje')::date", 10: `'${days <= 62 ? 'day' : 'month'}'`,
    11: 'public.report_excluded_phone8s()',
    12: "(SELECT to_char(min(a.day), 'YYYY-MM-DD') FROM public.agent_presence_days a)",
    13: '(SELECT max(r.finished_at) FROM public.order_decider_runs r)',
  };
  return m[1].replace(/\$(\d+)/g, (all, k) => vals[k] ?? all);
}

async function people(ctx, win, person = null) {
  const t0 = Date.now();
  let body;
  if (ctx.live) {
    const [r] = await runSql(`SELECT public.insights_people(${tsLit(win.fromIso)}, ${tsLit(win.toEndIso)}, ${tsLit(win.prev?.fromIso)}, ${tsLit(win.prev?.toEndIso)}, ${person ? `${q(person)}::uuid` : 'NULL::uuid'}) AS j`);
    body = parseJson(r.j);
  } else {
    const rows = await runSql(bodyFromMigration(ctx.migration, { ...win, person }));
    body = parseJson(Object.values(rows[0])[0]);
  }
  ctx.timings.push({ window: `${win.from}..${win.to}`, compare: !!win.prev, person: !!person, ms: Date.now() - t0 });
  return body;
}

async function cohort(win) {
  const [r] = await runSql(`SELECT public.insights_cohort(${tsLit(win.fromIso)}, ${tsLit(win.toEndIso)}, ${tsLit(win.prev?.fromIso)}, ${tsLit(win.prev?.toEndIso)}, NULL, true) AS j`);
  return parseJson(r.j);
}

function moneyKeys(v, out = []) {
  if (Array.isArray(v)) v.forEach((x) => moneyKeys(x, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/(_mkd|_eur)$/.test(k)) out.push(k); moneyKeys(x, out); }
  return out;
}

async function verifyWindow(ctx, from, to) {
  const win = ctx.IC.insightsWindows(from, to, true, ctx.now);
  if ('error' in win) throw new Error(win.error);
  const [p, c] = await Promise.all([people(ctx, win), cohort(win)]);
  const checks = [];
  const add = (id, title, lines) => checks.push({ id, title, lines, status: lines.every((l) => l.ok) ? 'PASS' : 'FAIL' });
  const t = p.totals;

  // A1
  add('A1', 'totals = the cohort (count, денари, COD, per source)', [
    tie('sales', n(c.total.count), n(t.sales)),
    // collabBox bookings awaiting their parcel (20260942001900): absent on both sides before it
    tie('booked (collabBox, awaiting the parcel)', n(c.total.booked), n(t.booked)),
    tie('value_mkd', n(c.total.value_mkd), n(t.value_mkd)),
    tie('cod_mkd', n(c.total.cod_mkd), n(t.cod_mkd)),
    ...SOURCES.map((s) => tie(`${s} sales`, n(c.by_source.find((x) => x.key === s)?.total?.count), n(t.by_source.find((x) => x.key === s)?.sales))),
    ...SOURCES.map((s) => tie(`${s} value_mkd`, n(c.by_source.find((x) => x.key === s)?.total?.value_mkd), n(t.by_source.find((x) => x.key === s)?.value_mkd))),
  ]);

  // A2
  const ns = p.no_seller;
  add('A2', 'Σ people + no seller = the cohort total (overall, per source)', [
    tie('Σ people.sales + no_seller.count = cohort total', n(c.total.count), sum(p.people, 'sales') + n(ns.count)),
    tie('Σ people.sales = totals.with_person', n(t.with_person), sum(p.people, 'sales')),
    tie('Σ no_seller reasons = no_seller.count', n(ns.count), sum(ns.reasons, 'count')),
    tie('no_seller.count = totals.without_person', n(t.without_person), n(ns.count)),
    ...SOURCES.map((s) => tie(`${s}: Σ people + no seller = cohort`,
      n(c.by_source.find((x) => x.key === s)?.total?.count),
      sum(p.people, (x) => x.by_source?.[s]) + sum(ns.reasons.filter((r) => r.source === s), 'count'))),
  ]);

  // A3
  const a3 = [];
  let badPeople = 0;
  for (const x of p.people) {
    if (sum(BUCKETS, (k) => x.buckets[k]) !== x.sales || sum(SOURCES, (k) => x.by_source[k]) !== x.sales) badPeople++;
  }
  a3.push(tie('people whose buckets / sources do not add up', 0, badPeople));
  for (const tm of p.teams) {
    a3.push(tie(`team ${tm.key}: Σ members.sales = team.sales`, tm.sales, sum(tm.members, 'sales')));
    a3.push(tie(`team ${tm.key}: Σ members.worked = team.worked`, tm.worked, sum(tm.members, 'worked')));
    a3.push(tie(`team ${tm.key}: Σ buckets = sales`, tm.sales, sum(BUCKETS, (k) => tm.buckets[k])));
  }
  a3.push(tie('Σ teams.sales = Σ people.sales', sum(p.people, 'sales'), sum(p.teams, 'sales')));
  a3.push(tie('Σ teams.worked = Σ people.worked', sum(p.people, 'worked'), sum(p.teams, 'worked')));
  a3.push(tie('Σ teams.packages = Σ people.packages', sum(p.people, 'packages'), sum(p.teams, 'packages')));
  a3.push(tie('Σ teams.booked = Σ people.booked', sum(p.people, 'booked'), sum(p.teams, 'booked')));
  a3.push(tie('Σ people.booked ≤ totals.booked (the rest have no person)', true, sum(p.people, 'booked') <= n(t.booked)));
  // a team whose members hold bookings never claims an exact /orders list
  a3.push(tie('teams with bookings are not drill_exact', 0, p.teams.filter((tm) => n(tm.booked) > 0 && tm.drill_exact).length));
  add('A3', 'the payload adds up (people, teams)', a3);

  // A4 — an independent GROUP BY of the cohort's rows
  const rows = await runSql(`
    SELECT r.person_id::text AS person_id, count(*)::int AS sales,
           ${BUCKETS.map((b) => `count(*) FILTER (WHERE r.bucket = '${b}')::int AS ${b}`).join(', ')}
    FROM public.insights_sale_rows(${tsLit(win.fromIso)}, ${tsLit(win.toEndIso)}, false) r
    WHERE r.in_total AND r.person_id IS NOT NULL
    GROUP BY r.person_id`);
  const byId = new Map(p.people.map((x) => [x.person_id, x]));
  let personMiss = 0, bucketMiss = 0;
  for (const r of rows) {
    const x = byId.get(r.person_id);
    if (!x || x.sales !== r.sales) personMiss++;
    else if (BUCKETS.some((b) => n(x.buckets[b]) !== n(r[b]))) bucketMiss++;
  }
  add('A4', 'every person = an independent GROUP BY of insights_sale_rows', [
    tie('people with sales (cohort) = people with sales (tab)', rows.length, p.people.filter((x) => x.sales > 0).length),
    tie('persons whose sales differ', 0, personMiss),
    tie('persons whose buckets differ', 0, bucketMiss),
  ]);

  // A5 — worked decisions recounted
  const [w] = await runSql(`
    WITH xtp AS (SELECT p.tracking_id AS tr FROM public.mex_parcels p WHERE p.phone8 = ANY (public.report_excluded_phone8s())),
    xto AS (SELECT x.id FROM public.orders x WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY (public.report_excluded_phone8s())
            UNION SELECT x.id FROM public.orders x JOIN xtp ON xtp.tr = x.mex_tracking_id)
    SELECT count(*)::int AS worked, count(*) FILTER (WHERE v.person_id IS NULL)::int AS unmapped,
           count(*) FILTER (WHERE v.outcome = 'sale')::int AS sale
    FROM public.v_sales_work v
    WHERE v.at BETWEEN ${tsLit(win.fromIso)} AND ${tsLit(win.toEndIso)}
      AND (v.order_id IS NULL OR v.order_id NOT IN (SELECT id FROM xto))`);
  add('A5', 'work = v_sales_work recounted', [
    tie('worked', w.worked, n(t.worked)),
    tie('sale decisions', w.sale, n(t.sale_decisions)),
    tie('decisions with no person', w.unmapped, n(t.unmapped_decisions)),
    tie('Σ people.worked + no person = worked', n(t.worked), sum(p.people, 'worked') + n(t.unmapped_decisions)),
  ]);

  // A6 — the /orders twin (the api's own PostgREST filter, translated to SQL)
  const [exRow] = await runSql(`SELECT public.insights_cohort_order_exceptions(${tsLit(win.fromIso)}, ${tsLit(win.toEndIso)}) AS j`);
  const ex = ctx.IC.parseCohortExceptions(parseJson(exRow.j));
  const window = { fromIso: win.fromIso, toEndIso: win.toEndIso };
  // 'total' = the eight in-total buckets (what parseCohortBucketParam expands it to)
  const base = drillPredicateParts(ctx.IC, { keys: [...ctx.IC.COHORT_BUCKETS], window, ex });
  const top = [...p.people].filter((x) => x.sales > 0).sort((a, b) => b.sales - a.sales).slice(0, 5);
  const exact = p.teams.filter((tm) => tm.drill_exact);
  const probes = [
    ...top.map((x) => ({ label: `person ${x.person_id.slice(0, 8)} (${x.sales}${n(x.booked) ? `, ${n(x.booked)} booked` : ''})`,
      want: x.sales - n(x.booked), pred: `o.sold_by_person_id = ${q(x.person_id)}::uuid` })),
    ...exact.map((tm) => ({
      label: `team ${tm.key} (${tm.sales})`, want: tm.sales,
      pred: `o.sold_by_person_id IN (SELECT m.person_id FROM public.sales_team_members m WHERE m.team_key = ${q(tm.key)} AND m.is_primary AND m.valid_from <= '${win.to}'::date AND (m.valid_to IS NULL OR m.valid_to >= '${win.from}'::date))`,
    })),
  ];
  let a6 = [];
  if (probes.length) {
    const [r] = await runSql(`SELECT ${probes.map((pr, i) => `count(*) FILTER (WHERE ${pr.pred})::int AS p${i}`).join(',\n  ')}
      FROM public.orders o WHERE ${base.join('\n  AND ')}`);
    a6 = probes.map((pr, i) => tie(`${pr.label}: /orders lists = the tab`, pr.want, r[`p${i}`]));
  }
  add('A6', 'person / team links list exactly their sales', a6);

  // A7 — compare
  add('A7', 'previous period = the cohort\'s previous period', [
    tie('prev sales', n(c.prev?.total?.count), n(t.prev?.sales)),
  ]);

  // A8 — the api's strips
  const IP = ctx.IP;
  const counts = IP.buildPeopleResponse(structuredClone(p), win, 'counts', null, ctx.now);
  const self = IP.buildPeopleResponse(structuredClone(p), win, 'self', top[0]?.person_id ?? null, ctx.now);
  add('A8', 'non-owner / agent payloads carry no money', [
    tie('money keys for an admin / manager', 0, moneyKeys(counts).length),
    tie('money keys for an agent', 0, moneyKeys(self).length),
    tie('an agent sees one person', top[0] ? 1 : 0, self.people.length),
  ]);

  return {
    window: { from: win.from, to: win.to, prev_from: win.prev?.from, prev_to: win.prev?.to },
    headline: {
      sales: t.sales, with_person: t.with_person, without_person: t.without_person, value_mkd: t.value_mkd,
      worked: t.worked, sale_decisions: t.sale_decisions, conversion: t.conversion,
      teams: Object.fromEntries(p.teams.map((tm) => [tm.key, { sales: tm.sales, worked: tm.worked, people: tm.people }])),
      no_seller: ns.reasons.map((r) => `${r.source}/${r.reason}${r.detail ? `/${r.detail}` : ''}: ${r.count}`),
    },
    checks,
  };
}

function parseArgs(argv) {
  const out = { windows: null, json: false, year: true };
  let from = null, to = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') out.json = true;
    else if (a === '--no-year') out.year = false;
    else if (a === '--from') from = argv[++i];
    else if (a === '--to') to = argv[++i];
    else throw Object.assign(new Error(`unknown argument ${a}`), { usage: true });
  }
  if (from || to) out.windows = [[from ?? to, to ?? from]];
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const IC = await loadTwin();
  const IP = await loadTs('supabase/functions/api/insightsPeople.ts');
  const [liveRow] = await runSql(`SELECT to_regprocedure('${SIG}') IS NOT NULL AS ok`);
  const ctx = { IC, IP, now: new Date(), live: liveRow.ok === true, migration: readFileSync(MIGRATION, 'utf8'), timings: [] };
  const results = [];
  for (const [from, to] of args.windows ?? DEFAULT_WINDOWS) results.push(await verifyWindow(ctx, from, to));
  if (args.year) {
    const win = IC.insightsWindows(YEAR_WINDOW[0], YEAR_WINDOW[1], false, ctx.now);
    await people(ctx, win);
  }
  const fail = results.some((r) => r.checks.some((c) => c.status === 'FAIL'));
  const doc = { mode: ctx.live ? 'rpc' : 'inline', results, timings: ctx.timings, status: fail ? 'FAIL' : 'PASS' };
  if (args.json) {
    console.log(JSON.stringify(doc, null, 2));
  } else {
    console.log(`verify-tab-agents · mode: ${doc.mode}`);
    for (const r of results) {
      console.log(`\n== ${r.window.from} … ${r.window.to} (prev ${r.window.prev_from} … ${r.window.prev_to})`);
      console.log(`   sales ${r.headline.sales} = with a seller ${r.headline.with_person} + without ${r.headline.without_person} · worked ${r.headline.worked} · sale decisions ${r.headline.sale_decisions} · conversion ${r.headline.conversion}`);
      console.log(`   teams ${JSON.stringify(r.headline.teams)}`);
      console.log(`   no seller: ${r.headline.no_seller.join(' · ')}`);
      for (const c of r.checks) {
        console.log(`   ${c.status}  ${c.id}  ${c.title}`);
        for (const l of c.lines) if (!l.ok) console.log(`          ✗ ${l.label}: want ${l.want}, got ${l.got}`);
      }
    }
    console.log('\ntimings (server round trip):');
    for (const t of ctx.timings) console.log(`   ${t.window}${t.compare ? ' +compare' : ''}${t.person ? ' +person' : ''}: ${t.ms} ms`);
    console.log(`\n${doc.status}`);
  }
  process.exit(fail ? 1 : 0);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(2); });
}
