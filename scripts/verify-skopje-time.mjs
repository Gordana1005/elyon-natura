/**
 * verify-skopje-time — READ-ONLY proof that the CRM counts on ONE clock: Europe/Skopje (owner
 * 01.10.2026: "we need to match everywhere that it's the same time").
 *
 *   node scripts/verify-skopje-time.mjs              (text report, today)
 *   node scripts/verify-skopje-time.mjs --day=2026-10-25
 *   node scripts/verify-skopje-time.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / DB unreachable.
 *
 *   K1  the clocks agree: crm_tz() = Europe/Skopje; the database's Skopje "now" and the api's
 *       (supabase/functions/api/skopjeTime.ts) are the same day and hour
 *   K2  day boundaries: for the day, its neighbours, the next 60 days and both 2026/27 DST
 *       changeover days, the api's skopjeMidnightIso / skopjeDayEndIso = Postgres'
 *       `(d)::timestamp AT TIME ZONE crm_tz()` (25.10.2026 has 25 hours, 28.03.2027 has 23)
 *   K3  the sale cohort, Skopje-bounded: insights_cohort(day) total = an independent recount of
 *       insights_sale_rows(day) in-total rows = the cohort's own spark point for the day; every
 *       row of the window is dated that Skopje day; yesterday + today = the two-day window
 *       (no gap, no overlap at midnight)
 *   K4  the TV board / Операции day: leaderboard_day_v2(day) answers that day with exactly the
 *       Skopje window [00:00, next 00:00)
 *   K5  orders "placed today": the Skopje-bounded count vs the UTC-bounded one (info: how many
 *       orders the old 02:00 boundary moved to the wrong day)
 *   K6  no report function still dates by the UTC calendar: no `now()::date`, `current_date`,
 *       `date_trunc('day', now())`, or a to_char(… AT TIME ZONE 'UTC', 'YYYY-MM…') day bucket in
 *       any public function, and no date column defaults to CURRENT_DATE / the UTC date
 *       (FAIL until 20260944000810…0840 are applied)
 *   K7  cron: pg_cron runs in UTC. Every job's UTC schedule is mapped to Skopje hours under the
 *       CURRENT offset (FAIL when a job would fire outside its intended Skopje hours) and under
 *       the other season's offset (WARN); jobs gated inside their function on the Skopje hour
 *       are checked to carry that gate
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia
 * (bmfxhgznttcnnlqloqzp), refused if .env points at Bulgaria, every statement a single SELECT /
 * WITH sent with read_only: true.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const n = (v) => Number(v ?? 0) || 0;
const iso = (v) => (v == null ? null : new Date(v).toISOString());

/** The api's own Skopje calendar (never a copy). */
async function loadSkopjeTime() {
  const file = join(ROOT, 'supabase', 'functions', 'api', 'skopjeTime.ts');
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    const esbuild = await import('esbuild');
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    fail(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}

// ── K7: what each cron job is meant to do, in Skopje hours ───────────────────
// gate: the function itself only acts in these Skopje hours (DST-proof by design) — the UTC
//       schedule must reach every one of them in BOTH seasons.
// quiet: no gate; the job must fire inside [from, to) Skopje in both seasons.
// any: runs around the clock (or every few minutes) — nothing to check.
const CRON_INTENT = {
  'collabbox-sync':              { gate: [0], fn: 'invoke_collabbox_sync' },
  'collabbox-sync-frequent':     { gate: range(7, 22), fn: 'invoke_collabbox_sync' },
  'customer-departments-nightly':{ gate: [1], fn: 'refresh_customer_departments_nightly' },
  'insights-profit-monthly':     { gate: [3], fn: 'insights_profit_refresh_nightly' },
  'shifts-runway-alert':         { gate: [17], fn: 'shifts_runway_alert' },
  'no-parcel-rule':              { gate: [21], fn: 'apply_no_parcel_rule' },
  'unpaid-delivery-chase':       { gate: [9, 10, 11], fn: 'notify_unpaid_shipped_orders' },
  'altercpa-sync-status':        { gate: range(7, 20), fn: 'invoke_altercpa_status_sync' },
  'mex-reconcile':               { gate: range(6, 22), fn: 'invoke_mex_reconcile' },
  'altercpa-rate-verdicts':      { gate: [10, 23], fn: 'altercpa_rate_verdict_sweep' },
  'lead-auto-distribute':        { gate: range(9, 19), fn: 'distribute_pending_leads' },
  'altercpa-guarantee-sweep':    { gate: [10, ...range(12, 21)], fn: 'altercpa_guarantee_sweep' },
  'nightly-segment-recompute':   { quiet: [0, 6] },
  'nightly-segment-recompute-shadow': { quiet: [0, 6] },
  'altercpa-sync-nightly':       { quiet: [0, 6] },
  'altercpa-sync-weekly':        { quiet: [0, 6] },
  'stamp-order-deciders-full':   { quiet: [0, 6] },
  'web-sync-nightly':            { quiet: [0, 6] },
  'personal-notes-purge':        { quiet: [0, 6] },
  'mex-reconcile-weekly':        { quiet: [6, 23] },   // "inside working hours", Sunday
};
function range(a, b) { const out = []; for (let h = a; h <= b; h++) out.push(h); return out; }

/** The UTC hours a 5-field cron expression fires in (minute field ignored). */
function cronHours(expr) {
  const f = String(expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const out = new Set();
  for (const part of f[1].split(',')) {
    const [rng, stepS] = part.split('/');
    const step = stepS ? Number(stepS) : 1;
    let lo = 0, hi = 23;
    if (rng !== '*') { const [a, b] = rng.split('-').map(Number); lo = a; hi = Number.isFinite(b) ? b : (stepS ? 23 : a); }
    for (let h = lo; h <= hi; h += step) out.add(h);
  }
  return [...out].sort((a, b) => a - b);
}

async function main() {
  const json = process.argv.includes('--json');
  const ST = await loadSkopjeTime();
  const now = new Date();

  // ── K1 ──
  const [clk] = await runSql(`
    SELECT public.crm_tz() AS crm_tz, current_setting('TimeZone') AS db_tz, now() AS now,
           to_char(now() AT TIME ZONE public.crm_tz(), 'YYYY-MM-DD') AS skopje_day,
           extract(hour FROM now() AT TIME ZONE public.crm_tz())::int AS skopje_hour,
           (extract(epoch FROM (now() AT TIME ZONE public.crm_tz()) - (now() AT TIME ZONE 'UTC')) / 3600)::int AS offset_h`);
  const today = clk.skopje_day;
  const day = ST.isValidYmd(arg('day')) ? arg('day') : today;
  const offset = n(clk.offset_h);
  {
    const c = check('K1', 'one clock: Postgres and the api agree on the Skopje day and hour');
    c.tie('crm_tz()', 'Europe/Skopje', clk.crm_tz);
    c.info('database TimeZone (every day must be computed with AT TIME ZONE, never ::date)', clk.db_tz);
    const dbNow = new Date(clk.now);
    c.tie('today (api skopjeTodayYmd at the database\'s now)', today, ST.skopjeTodayYmd(dbNow));
    c.tie('hour (api skopjeHour)', n(clk.skopje_hour), ST.skopjeHour(dbNow));
    c.info('current Skopje offset', `UTC+${offset} (${offset === 2 ? 'CEST, summer' : 'CET, winter'})`);
    if (Math.abs(dbNow - now) > 5 * 60_000) c.warn('this machine\'s clock vs the database', `${Math.round((now - dbNow) / 1000)} s apart`);
  }

  // ── K2 ──
  {
    const c = check('K2', 'day boundaries: api (DST-exact) = Postgres AT TIME ZONE crm_tz()');
    const days = new Set([ST.addDaysYmd(day, -1), day, ST.addDaysYmd(day, 1),
      '2026-03-28', '2026-03-29', '2026-03-30', '2026-10-24', '2026-10-25', '2026-10-26',
      '2027-03-27', '2027-03-28', '2027-03-29', '2027-10-30', '2027-10-31', '2027-11-01']);
    for (let i = 0; i < 60; i++) days.add(ST.addDaysYmd(today, i));
    const list = [...days].sort();
    const rows = await runSql(`
      SELECT d::text AS day,
             (d::timestamp AT TIME ZONE public.crm_tz()) AS start,
             ((d + 1)::timestamp AT TIME ZONE public.crm_tz()) AS next,
             extract(epoch FROM ((d + 1)::timestamp AT TIME ZONE public.crm_tz()) - (d::timestamp AT TIME ZONE public.crm_tz())) / 3600 AS hours
        FROM unnest(ARRAY[${list.map((d) => `DATE '${d}'`).join(', ')}]) AS d ORDER BY d`);
    let bad = 0;
    for (const r of rows) {
      const wantStart = iso(r.start), wantNext = iso(r.next);
      const gotStart = ST.skopjeMidnightIso(r.day);
      const gotEndPlus = new Date(Date.parse(ST.skopjeDayEndIso(r.day)) + 1).toISOString();
      if (wantStart !== gotStart || wantNext !== gotEndPlus) {
        bad++;
        c.fail(`${r.day}`, `Postgres [${wantStart}, ${wantNext}) vs api [${gotStart}, ${gotEndPlus})`);
      }
      if (n(r.hours) !== 24) c.info(`${r.day} has ${n(r.hours)} hours`, `${wantStart} → ${wantNext}`);
    }
    c.tie(`${rows.length} days compared, mismatches`, 0, bad);
  }

  // ── K3 ──
  const start = ST.skopjeMidnightIso(day);
  const endIncl = ST.skopjeDayEndIso(day);
  const yStart = ST.skopjeMidnightIso(ST.addDaysYmd(day, -1));
  const SOURCES = `ARRAY['altercpa','elyon_crm','teleshop_out','teleshop_other','social','web']`;
  {
    const c = check('K3', `the sale cohort of ${day} is exactly the Skopje day`);
    const [r] = await runSql(`
      WITH c AS (SELECT public.insights_cohort('${start}'::timestamptz, '${endIncl}'::timestamptz, NULL, NULL, ${SOURCES}, false) AS j),
           rows AS (SELECT * FROM public.insights_sale_rows('${start}'::timestamptz, '${endIncl}'::timestamptz, false))
      SELECT (SELECT (j -> 'total' ->> 'count')::int FROM c) AS cohort_total,
             (SELECT (SELECT (p ->> 'count')::int FROM jsonb_array_elements(j -> 'spark') p WHERE p ->> 'd' = '${day}') FROM c) AS spark_point,
             (SELECT count(*) FROM rows WHERE in_total) AS recount,
             (SELECT count(*) FROM rows) AS all_rows,
             (SELECT count(*) FROM rows WHERE sale_day <> DATE '${day}') AS other_day,
             (SELECT count(*) FROM rows WHERE sale_at < '${start}'::timestamptz OR sale_at > '${endIncl}'::timestamptz) AS outside_window`);
    c.tie('insights_cohort total = recount of insights_sale_rows (in-total rows)', n(r.recount), n(r.cohort_total));
    c.tie('insights_cohort total = its own spark point for the day', n(r.cohort_total), n(r.spark_point));
    c.tie('rows of the window dated another Skopje day', 0, n(r.other_day));
    c.tie('rows outside [00:00, 24:00) Skopje', 0, n(r.outside_window));
    c.info('sales of the day (cohort total) / all rows', `${n(r.cohort_total)} / ${n(r.all_rows)}`);
    const [p] = await runSql(`
      SELECT (SELECT count(*) FROM public.insights_sale_rows('${yStart}'::timestamptz, '${endIncl}'::timestamptz, false)) AS two_days,
             (SELECT count(*) FROM public.insights_sale_rows('${yStart}'::timestamptz, '${ST.skopjeDayEndIso(ST.addDaysYmd(day, -1))}'::timestamptz, false)) AS yesterday,
             (SELECT count(*) FROM public.insights_sale_rows('${start}'::timestamptz, '${endIncl}'::timestamptz, false)) AS today`);
    c.tie('yesterday + today = the two-day window (midnight loses / doubles nothing)', n(p.two_days), n(p.yesterday) + n(p.today));
  }

  // ── K4 ──
  {
    const c = check('K4', `the TV board / Операции day ${day} = the Skopje window`);
    const [r] = await runSql(`
      WITH b AS (SELECT public.leaderboard_day_v2(DATE '${day}', NULL, NULL) AS j)
      SELECT j ->> 'day' AS day, j -> 'window' ->> 'from' AS w_from, j -> 'window' ->> 'to_end' AS w_to
        FROM b`);
    c.tie('leaderboard_day_v2 day', day, String(r.day).slice(0, 10));
    c.tie('window from = Skopje 00:00', start, iso(r.w_from));
    // the board's inclusive end is next midnight − 1 µs; ours is − 1 µs too (…59.999999)
    c.tie('window to_end = the day\'s last instant', ST.skopjeDayEndIso(day).replace(/\.\d+Z$/, ''), iso(r.w_to)?.replace(/\.\d+Z$/, ''));
  }

  // ── K5 ──
  {
    const c = check('K5', `orders placed on ${day}: Skopje day vs the old UTC day (info)`);
    const [r] = await runSql(`
      SELECT count(*) FILTER (WHERE created_at >= '${start}'::timestamptz AND created_at <= '${endIncl}'::timestamptz) AS skopje,
             count(*) FILTER (WHERE created_at >= DATE '${day}'::timestamptz AND created_at < (DATE '${day}' + 1)::timestamptz) AS utc,
             count(*) FILTER (WHERE created_at >= '${start}'::timestamptz AND created_at < DATE '${day}'::timestamptz) AS early_hours
        FROM public.orders
       WHERE created_at >= '${yStart}'::timestamptz AND created_at < (DATE '${day}' + 2)::timestamptz`);
    c.info('placed (Skopje 00:00–24:00)', n(r.skopje));
    c.info('placed (UTC day — what a naked ::timestamptz date counted)', n(r.utc));
    c.info(`placed 00:00–0${offset}:00 Skopje (the hours the UTC day filed under the day before)`, n(r.early_hours));
  }

  // ── K6 ──
  {
    const c = check('K6', 'no function or default dates by the UTC calendar');
    const rows = await runSql(`
      SELECT p.proname AS fn,
             (p.prosrc ~* 'now\\(\\)\\s*::\\s*date') AS now_date,
             (p.prosrc ~* '\\mcurrent_date\\M') AS current_date,
             (p.prosrc ~* 'date_trunc\\(\\s*''day''\\s*,\\s*now\\(\\)\\s*\\)') AS trunc_now,
             (p.prosrc ~* 'to_char\\([^;]*?AT TIME ZONE ''UTC''\\s*,\\s*''YYYY-MM') AS utc_bucket
        FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace
         AND (p.prosrc ~* 'now\\(\\)\\s*::\\s*date' OR p.prosrc ~* '\\mcurrent_date\\M'
              OR p.prosrc ~* 'date_trunc\\(\\s*''day''\\s*,\\s*now\\(\\)\\s*\\)'
              OR p.prosrc ~* 'to_char\\([^;]*?AT TIME ZONE ''UTC''\\s*,\\s*''YYYY-MM')
       ORDER BY 1`);
    // A labelled-UTC technical note (the AlterCPA sweep's "cursor … UTC") is not a day bucket.
    const ALLOWED = new Set(['altercpa_sweeps_close_stale']);
    let offenders = 0;
    for (const r of rows) {
      const why = ['now_date', 'current_date', 'trunc_now', 'utc_bucket'].filter((k) => r[k]).join(', ');
      if (ALLOWED.has(r.fn)) { c.info(`${r.fn} (allowed: a labelled UTC log text)`, why); continue; }
      offenders++;
      c.fail(r.fn, why);
    }
    const defs = await runSql(`
      SELECT table_name || '.' || column_name AS col, column_default AS def
        FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'date' AND column_default IS NOT NULL
         AND column_default !~* 'skopje|crm_tz'
         AND (column_default ~* 'current_date|now\\(\\)|utc')`);
    for (const d of defs) { offenders++; c.fail(`default ${d.col}`, d.def); }
    c.tie('functions / defaults on the UTC calendar', 0, offenders);
  }

  // ── K7 ──
  {
    const c = check('K7', `cron (UTC) → Skopje hours, now UTC+${offset}; the other season (UTC+${offset === 2 ? 1 : 2}) is a WARN`);
    const jobs = await runSql(`SELECT jobname, schedule, active, command FROM cron.job ORDER BY jobname`);
    const srcs = await runSql(`
      SELECT p.proname AS fn,
             (p.prosrc ~* 'extract\\s*\\(\\s*hour\\s+from\\s+.{0,120}?(at time zone|_local\\M|_now\\M|_skopje_now\\M)') AS skopje_hour_gate
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
         AND p.proname IN (${[...new Set(Object.values(CRON_INTENT).map((x) => x.fn).filter(Boolean))].map((f) => `'${f}'`).join(', ')})`);
    const gateOk = new Map(srcs.map((s) => [s.fn, s.skopje_hour_gate]));
    const other = offset === 2 ? 1 : 2;
    for (const j of jobs) {
      const intent = CRON_INTENT[j.jobname];
      const hours = cronHours(j.schedule);
      if (!j.active) { c.info(`${j.jobname} (inactive)`, j.schedule); continue; }
      if (!intent || !hours) { c.info(j.jobname, `${j.schedule} — runs around the clock`); continue; }
      const skopje = (off) => hours.map((h) => (h + off) % 24);
      const hrs = (off) => (hours.length === 24 ? 'every hour' : `${skopje(off).join(',')}h`);
      const label = `${j.jobname} '${j.schedule}' → Skopje ${hrs(offset)} (at UTC+${other}: ${hrs(other)})`;
      if (intent.gate) {
        if (intent.fn && gateOk.get(intent.fn) !== true) c.fail(`${j.jobname}: ${intent.fn}() carries no Skopje-hour gate`, 'expected extract(hour FROM … AT TIME ZONE Skopje)');
        const missNow = intent.gate.filter((h) => !skopje(offset).includes(h));
        const missOther = intent.gate.filter((h) => !skopje(other).includes(h));
        if (missNow.length) c.fail(label, `never reaches Skopje hour(s) ${missNow.join(',')} now`);
        else if (missOther.length) c.warn(label, `would miss Skopje hour(s) ${missOther.join(',')} at UTC+${other}`);
        else c.info(label, `gated on ${intent.gate.length === 1 ? intent.gate[0] + ':xx' : intent.gate[0] + '–' + intent.gate.at(-1) + 'h'} Skopje — DST-proof`);
      } else if (intent.quiet) {
        const [lo, hi] = intent.quiet;
        const out = (off) => skopje(off).filter((h) => h < lo || h >= hi);
        if (out(offset).length) c.fail(label, `fires at ${out(offset).join(',')}h Skopje, outside ${lo}:00–${hi}:00`);
        else if (out(other).length) c.warn(label, `would fire at ${out(other).join(',')}h Skopje at UTC+${other}`);
        else c.info(label, `fixed UTC; inside ${lo}:00–${hi}:00 Skopje in both seasons`);
      }
    }
  }

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-skopje-time', read_only: true, day, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results }, null, 2));
  } else {
    console.log(`verify-skopje-time · read-only · Macedonia · day ${day} · Skopje now UTC+${offset}`);
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: ${l.want == null ? l.got : `want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`}`);
        else console.log(`        ✓ ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
      }
    }
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-skopje-time error: ${e?.message ?? e}`); process.exit(2); });
