/**
 * verify-tab-work — READ-ONLY proof that Insights → Work ("Активност на повици",
 * migration 20260941000600, GET /api/insights/work) ties out.
 *
 *   node scripts/verify-tab-work.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-tab-work.mjs --from 2026-09-01 --to 2026-09-27 --json
 *
 *   --from/--to  Skopje days, inclusive (default: the 7 days ending today). The
 *                windows come from the api's own helper (insightsCommon.ts).
 *   --json       one JSON document on stdout instead of the report
 *
 * Before the migration is applied the script runs the migration's own query
 * bodies inline (the same text, parameters substituted) — "mode: inline" — so
 * the numbers can be proven before anything ships; afterwards it calls the RPCs.
 * Either way the payload is shaped by the api's own buildWorkResponse().
 *
 * Checks:
 *   W1  Σ people.worked (+ decisions no person owns) = totals.worked; each team's
 *       totals = Σ its members
 *   W2  totals = an independent recount of public.v_sales_work (decisions on the
 *       owner's test-phone orders excluded) — worked, via crm / altercpa, each outcome
 *   W3  every person's "worked" = the Overview's (insights_overview teams[].members[])
 *   W4  every person's credited sales = an independent GROUP BY of the sale
 *       cohort (insights_sale_rows in_total, sold_by_person_id) — the cohort's person totals
 *   W5  no-answer clicks / call logs / timed calls / handling = call_logs recounted
 *   W6  Σ per_day (every team, '__none__' included) = totals, credited included
 *   W7  every person with a decision in the window has a row
 *   W8  the day swimlane for --to: Σ row decisions + unattributed = v_sales_work that day
 *   W9  no money key (*_eur / *_mkd) anywhere in either payload
 *   T   timings (the RPC / inline body, server side)
 *
 * Safety: pinned to Macedonia by the shared guard in verify-insights-ties.mjs
 * (config.toml + .env checked, every statement a single SELECT/WITH, sent with
 * read_only: true). Nothing is written.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260941000600_insights_work.sql');
const USAGE = 'usage: node scripts/verify-tab-work.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]';

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

const lit = (v, type) => (v == null ? `NULL::${type}` : `'${String(v).replace(/'/g, "''")}'::${type}`);
const XP = '(SELECT public.report_excluded_phone8s())';

/** The migration's dynamic query body with its $n parameters as literals. */
function inlineBody(tag, params) {
  const sql = readFileSync(MIGRATION, 'utf8');
  const parts = sql.split(tag);
  if (parts.length < 3) throw new Error(`${tag} body not found in the migration`);
  let body = parts[1];
  // highest index first so $1 never eats $10
  for (const [i, v] of [...params.entries()].reverse()) body = body.replace(new RegExp(`\\$${i + 1}\\b`, 'g'), v);
  return body;
}

async function timed(sql) {
  const rows = await runSql(`SELECT (clock_timestamp() - statement_timestamp())::text AS el0, x.* FROM (${sql}) x`);
  return rows[0];
}

async function rpcExists(sig) {
  const r = await runSql(`SELECT to_regprocedure('${sig}') IS NOT NULL AS ok`);
  return r[0].ok === true;
}

export async function verify({ from, to }) {
  const IC = await loadTs('supabase/functions/api/insightsCommon.ts');
  const IW = await loadTs('supabase/functions/api/insightsWork.ts');
  const win = IC.insightsWindows(from ?? null, to ?? null, true);
  if ('error' in win) throw new Error(win.error);
  const applied = await rpcExists('public.insights_work(timestamptz,timestamptz,timestamptz,timestamptz,uuid)');
  const mode = applied ? 'rpc' : 'inline';
  const t = {};

  // ── the payloads ────────────────────────────────────────────────────────
  let work, credited, prevCredited, dayRaw;
  const stamp = async (key, sql) => {
    const t0 = Date.now();
    const r = await timed(sql);
    t[key] = { server: r.el0, wall_ms: Date.now() - t0 };
    return r;
  };
  if (applied) {
    work = (await stamp('work', `SELECT public.insights_work(${lit(win.fromIso, 'timestamptz')}, ${lit(win.toEndIso, 'timestamptz')}, ${lit(win.prev?.fromIso, 'timestamptz')}, ${lit(win.prev?.toEndIso, 'timestamptz')}, NULL) AS j`)).j;
    credited = (await stamp('credited', `SELECT public.insights_work_credited(${lit(win.fromIso, 'timestamptz')}, ${lit(win.toEndIso, 'timestamptz')}, NULL) AS j`)).j;
    prevCredited = win.prev ? (await stamp('credited_prev', `SELECT public.insights_work_credited(${lit(win.prev.fromIso, 'timestamptz')}, ${lit(win.prev.toEndIso, 'timestamptz')}, NULL) AS j`)).j : null;
  } else {
    const core = inlineBody('$core$', [
      lit(win.fromIso, 'timestamptz'), lit(win.toEndIso, 'timestamptz'),
      lit(win.prev?.fromIso, 'timestamptz'), lit(win.prev?.toEndIso, 'timestamptz'),
      XP, 'NULL', 'NULL',
    ]);
    work = (await stamp('work', core)).jsonb_build_object;
    // insights_work_credited's body, with its variables as literals
    const cr = (a, b) => {
      const gran = `CASE WHEN (${lit(b, 'timestamptz')} AT TIME ZONE 'Europe/Skopje')::date - (${lit(a, 'timestamptz')} AT TIME ZONE 'Europe/Skopje')::date + 1 <= 62 THEN 'day' ELSE 'week' END`;
      return `WITH r AS MATERIALIZED (
          SELECT r.person_id, r.kind, r.sale_day FROM public.insights_sale_rows(${lit(a, 'timestamptz')}, ${lit(b, 'timestamptz')}, false) r WHERE r.in_total
        ), x AS (
          SELECT r.person_id, CASE WHEN ${gran} = 'day' THEN r.sale_day ELSE date_trunc('week', r.sale_day)::date END AS b, count(*) AS n
          FROM r WHERE r.person_id IS NOT NULL GROUP BY 1, 2
        )
        SELECT jsonb_build_object('gran', ${gran}, 'total', (SELECT coalesce(sum(x.n), 0) FROM x),
          'no_seller', (SELECT count(*) FROM r WHERE r.kind IN ('order', 'booking') AND r.person_id IS NULL),
          'rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('p', x.person_id, 'b', to_char(x.b, 'YYYY-MM-DD'), 'n', x.n)), '[]'::jsonb) FROM x)) AS j`;
    };
    credited = (await stamp('credited', cr(win.fromIso, win.toEndIso))).j;
    prevCredited = win.prev ? (await stamp('credited_prev', cr(win.prev.fromIso, win.prev.toEndIso))).j : null;
  }
  const payload = IW.buildWorkResponse(work, credited, prevCredited, win, { self: false });

  const day = IW.parseWorkDay(win.to);
  if ('error' in day) throw new Error(day.error);
  if (applied) {
    dayRaw = (await stamp('day', `SELECT public.insights_work_day(${lit(day.fromIso, 'timestamptz')}, ${lit(day.toEndIso, 'timestamptz')}, NULL) AS j`)).j;
  } else {
    dayRaw = (await stamp('day', inlineBody('$day$', [lit(day.fromIso, 'timestamptz'), lit(day.toEndIso, 'timestamptz'), XP, 'NULL', 'NULL']))).jsonb_build_object;
  }
  const dayPayload = IW.buildWorkDayResponse(dayRaw, day, { self: false });

  // ── independent recounts ────────────────────────────────────────────────
  const W = `${lit(win.fromIso, 'timestamptz')} AND ${lit(win.toEndIso, 'timestamptz')}`;
  const XTO = `(SELECT x.id FROM public.orders x WHERE right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = ANY (${XP}::text[])
               UNION SELECT x.id FROM public.orders x JOIN public.mex_parcels p ON p.tracking_id = x.mex_tracking_id WHERE p.phone8 = ANY (${XP}::text[]))`;
  const [led] = await runSql(`SELECT count(*)::int AS worked,
      count(*) FILTER (WHERE via = 'crm')::int AS via_crm, count(*) FILTER (WHERE via = 'altercpa')::int AS via_altercpa,
      count(*) FILTER (WHERE outcome = 'sale')::int AS sale, count(*) FILTER (WHERE outcome = 'cancel')::int AS cancel,
      count(*) FILTER (WHERE outcome = 'trash')::int AS trash, count(*) FILTER (WHERE outcome = 'callback')::int AS callback,
      count(*) FILTER (WHERE person_id IS NULL)::int AS no_person
    FROM public.v_sales_work v
    WHERE v.at BETWEEN ${W} AND (v.order_id IS NULL OR v.order_id NOT IN ${XTO})`);
  const ledPeople = await runSql(`SELECT v.person_id::text AS p, count(*)::int AS n FROM public.v_sales_work v
    WHERE v.at BETWEEN ${W} AND v.person_id IS NOT NULL AND (v.order_id IS NULL OR v.order_id NOT IN ${XTO}) GROUP BY 1`);
  const [cl] = await runSql(`SELECT count(*)::int AS call_logs, count(*) FILTER (WHERE outcome = 'no_answer')::int AS no_answer,
      count(*) FILTER (WHERE started_at IS NOT NULL)::int AS timed_calls,
      coalesce(sum(total_seconds) FILTER (WHERE started_at IS NOT NULL), 0)::int AS handling_sec
    FROM public.call_logs c
    WHERE coalesce(c.started_at, c.created_at) BETWEEN ${W}
      AND NOT coalesce(right(regexp_replace(c.customer_phone, '[^0-9]', '', 'g'), 8) = ANY (${XP}::text[]), false)`);
  const cohortPeople = await runSql(`SELECT r.person_id::text AS p, count(*)::int AS n
    FROM public.insights_sale_rows(${lit(win.fromIso, 'timestamptz')}, ${lit(win.toEndIso, 'timestamptz')}, false) r
    WHERE r.in_total AND r.person_id IS NOT NULL GROUP BY 1`);
  const [ov] = await runSql(`SELECT public.insights_overview(${lit(win.fromIso, 'text')}, ${lit(win.toEndIso, 'text')}, NULL, NULL) -> 'teams' AS teams`);
  const dayStart = lit(day.fromIso, 'timestamptz'), dayEnd = lit(day.toEndIso, 'timestamptz');
  const [dayLed] = await runSql(`SELECT count(*)::int AS n FROM public.v_sales_work v
    WHERE v.at BETWEEN ${dayStart} AND ${dayEnd} AND (v.order_id IS NULL OR v.order_id NOT IN ${XTO})`);

  // ── checks ──────────────────────────────────────────────────────────────
  const results = [];
  const check = (id, name, ok, detail) => results.push({ id, name, status: ok ? 'PASS' : 'FAIL', detail });
  const people = payload.teams.flatMap((tm) => tm.members);
  const tot = payload.totals;
  const q = payload.quality ?? {};

  const sumWorked = people.reduce((a, p) => a + p.worked, 0);
  check('W1', 'Σ people.worked + no person = totals.worked', sumWorked + (q.no_person ?? 0) === tot.worked,
    `${sumWorked} + ${q.no_person ?? 0} vs ${tot.worked}`);
  const teamBad = payload.teams.filter((tm) => tm.totals.worked !== tm.members.reduce((a, m) => a + m.worked, 0)
    || tm.totals.sale !== tm.members.reduce((a, m) => a + m.sale, 0)
    || tm.totals.no_answer !== tm.members.reduce((a, m) => a + m.no_answer, 0));
  check('W1', 'each team = Σ its members', teamBad.length === 0, teamBad.map((tm) => tm.team_key).join(', ') || `${payload.teams.length} teams`);

  const keys = ['worked', 'via_crm', 'via_altercpa', 'sale', 'cancel', 'trash', 'callback'];
  const w2 = keys.filter((k) => tot[k] !== led[k]);
  check('W2', 'totals = v_sales_work recount', w2.length === 0 && (q.no_person ?? 0) === led.no_person,
    w2.length ? w2.map((k) => `${k} ${tot[k]} vs ${led[k]}`).join('; ') : keys.map((k) => `${k} ${tot[k]}`).join(' · '));

  const ovWorked = new Map();
  for (const tm of ov.teams ?? []) for (const m of tm.members ?? []) ovWorked.set(m.person_id, m.worked);
  const w3 = people.filter((p) => ovWorked.has(p.person_id) && ovWorked.get(p.person_id) !== p.worked);
  const w3missing = people.filter((p) => p.worked > 0 && !ovWorked.has(p.person_id));
  check('W3', 'person worked = the Overview teams block', w3.length === 0 && w3missing.length === 0,
    w3.length || w3missing.length
      ? [...w3.map((p) => `${p.name} ${p.worked} vs ${ovWorked.get(p.person_id)}`), ...w3missing.map((p) => `${p.name} not on the Overview`)].join('; ')
      : `${people.filter((p) => ovWorked.has(p.person_id)).length} people compared`);

  const coh = new Map(cohortPeople.map((r) => [r.p, r.n]));
  const w4 = [];
  for (const p of people) if ((coh.get(p.person_id) ?? 0) !== (p.credited ?? 0)) w4.push(`${p.name} ${p.credited} vs ${coh.get(p.person_id) ?? 0}`);
  for (const [pid, n] of coh) if (!people.some((p) => p.person_id === pid)) w4.push(`person ${pid} (${n}) has no row`);
  const cohTotal = cohortPeople.reduce((a, r) => a + r.n, 0);
  check('W4', 'person credited = the cohort (insights_sale_rows) person totals', w4.length === 0 && tot.credited === cohTotal,
    w4.length ? w4.slice(0, 8).join('; ') : `${coh.size} people · ${cohTotal} credited sales`);

  const w5 = ['call_logs', 'no_answer', 'timed_calls', 'handling_sec'].filter((k) => tot[k] !== cl[k]);
  check('W5', 'call logs = call_logs recount', w5.length === 0,
    w5.length ? w5.map((k) => `${k} ${tot[k]} vs ${cl[k]}`).join('; ') : `no-answer ${cl.no_answer} · timed ${cl.timed_calls} · ${cl.handling_sec} s`);

  const pd = (k) => payload.per_day.reduce((a, p) => a + p[k], 0);
  const w6 = ['worked', 'sale', 'cancel', 'trash', 'callback', 'no_answer', 'call_logs', 'credited'].filter((k) => pd(k) !== tot[k]);
  check('W6', 'Σ per_day = totals', w6.length === 0, w6.length ? w6.map((k) => `${k} ${pd(k)} vs ${tot[k]}`).join('; ') : `${payload.per_day.length} day × team points`);

  const rowIds = new Set(people.map((p) => p.person_id));
  const w7 = ledPeople.filter((r) => !rowIds.has(r.p));
  check('W7', 'everyone who decided has a row', w7.length === 0, w7.length ? w7.map((r) => `${r.p} (${r.n})`).join(', ') : `${ledPeople.length} people`);

  const dayRows = dayPayload.people.reduce((a, p) => a + p.decisions.length, 0) + dayPayload.unattributed.decisions;
  check('W8', `swimlane ${win.to}: Σ rows + unattributed = v_sales_work that day`, dayRows === dayLed.n,
    `${dayRows} vs ${dayLed.n} · ${dayPayload.people.length} rows`);

  const moneyKeys = [];
  const walk = (v, path) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (/(_eur|_mkd)$/.test(k)) moneyKeys.push(`${path}.${k}`); walk(x, `${path}.${k}`); }
  };
  walk(payload, 'work'); walk(dayPayload, 'day');
  check('W9', 'no money key in either payload', moneyKeys.length === 0, moneyKeys.slice(0, 5).join(', ') || 'none');

  return { mode, window: { from: win.from, to: win.to, prev_from: win.prev?.from, prev_to: win.prev?.to }, timings: t, results, totals: tot, prev: payload.prev, callbacks: payload.callbacks, quality: payload.quality };
}

function parseArgs(argv) {
  const o = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--from') o.from = argv[++i];
    else if (a === '--to') o.to = argv[++i];
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown argument ${a}\n${USAGE}`);
  }
  return o;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return 0; }
  const r = await verify(opts);
  const fail = r.results.some((x) => x.status === 'FAIL');
  if (opts.json) {
    console.log(JSON.stringify({ tool: 'verify-tab-work', read_only: true, generated_at: new Date().toISOString(), exit_code: fail ? 1 : 0, ...r }, null, 2));
  } else {
    console.log(`verify-tab-work  ${r.window.from} → ${r.window.to}  (previous ${r.window.prev_from} → ${r.window.prev_to})  mode: ${r.mode}`);
    for (const x of r.results) console.log(`  ${x.status === 'PASS' ? 'PASS' : 'FAIL'}  ${x.id}  ${x.name} — ${x.detail}`);
    const tt = r.totals;
    console.log(`  H    decisions ${tt.worked} (CRM ${tt.via_crm} · AlterCPA ${tt.via_altercpa}) · sale decisions ${tt.sale} · conversion ${tt.conversion}`
      + ` · credited ${tt.credited} · no-answer ${tt.no_answer} · reach ${tt.reach} · people ${tt.people} · timed ${tt.timed_calls} / ${tt.handling_sec} s`);
    if (r.prev) console.log(`       previous: decisions ${r.prev.worked} · sale ${r.prev.sale} · credited ${r.prev.credited} · no-answer ${r.prev.no_answer} · people ${r.prev.people}`);
    console.log(`  T    ${Object.entries(r.timings).map(([k, v]) => `${k} ${v.server}`).join(' · ')}`);
    console.log(fail ? 'FAIL' : 'OK');
  }
  return fail ? 1 : 0;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  const norm = (p) => { let real = p; try { real = realpathSync(p); } catch { /* as given */ } return process.platform === 'win32' ? real.toLowerCase() : real; };
  return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
}

if (invokedAsCli()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (e) => {
    console.error(`verify-tab-work error: ${e?.message ?? e}`);
    process.exitCode = 2;
  });
}
