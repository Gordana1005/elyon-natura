/**
 * verify-altercpa-guarantee — READ-ONLY proof that the AlterCPA 30% guarantee read model
 * (plan 01.10.2026, Фаза 3–5; migrations 20260944000200 / 0210 / 0300) counts what the owner
 * decided: rate = (approved + cancel_other) ÷ every Macedonian lead, test leads apart.
 *
 *   node scripts/verify-altercpa-guarantee.mjs           (text report)
 *   node scripts/verify-altercpa-guarantee.mjs --json
 *   node scripts/verify-altercpa-guarantee.mjs --day 2026-10-01   (the day of G7; default today, Skopje)
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   G1  leads = approved + cancel_other + cancelled + trashed + open — every day / webmaster /
 *       stream / offer row of the last 30 days
 *   G2  counted = approved + cancel_other — every row
 *   G3  the day grain = Σ webmaster = Σ (webmaster, stream) = Σ (webmaster, offer), every count column
 *   G4  altercpa_need_confirm() = max(0, ceil(30·N/100) − C) recomputed in integers — every cohort
 *       of 30 days, the grid N 0..400 × C {0, 7, 21, 60}, and N = 70 → 21 (the float trap)
 *   G5  test leads of September (≈ 76): rates.test_excluded = an independent recount on
 *       altercpa_leads (AlterCPA test order OR owner test phone OR excluded webmaster)
 *   G6  September: rates totals = an independent recount on altercpa_leads (5.754 leads raw,
 *       2.044 counted on 01.10.2026 — printed beside)
 *   G7  the Лидови list = the Стапки counts for one day: journal total WITH test = leads +
 *       test_excluded; journal total of decision=open = open; and per decision
 *   G8  after 20260944000300: the two old triggers are gone, cron altercpa-guarantee-sweep is
 *       scheduled and altercpa-rate-verdicts is not, the ledger CHECK knows the new kinds, and
 *       the new alerts stay under their limits; the arrival index is VALID
 *   T   timings
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) — pinned to
 * Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single
 * SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const COLS = ['leads', 'test_excluded', 'approved', 'cancel_other', 'cancelled', 'trashed', 'open', 'counted', 'mex_shipped', 'crm_sticky'];
const DECISIONS = ['approved', 'cancel_other', 'cancelled', 'trashed', 'open'];

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
    skip(label) { c.lines.push({ label, want: null, got: 'skipped', ok: true, info: true }); c.status = 'SKIP'; },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}
const ceilDiv = (a, b) => Math.floor(a / b) + (a % b === 0 ? 0 : 1);
const needOf = (counted, leads, target) => Math.max(0, ceilDiv(Math.round(target * 100) * leads, 10_000) - counted);

// The independent definition, written from altercpa_leads directly (not through the base function).
const TEST_PRED = `(l.skip_reason IS NOT DISTINCT FROM 'test_order'
   OR right(regexp_replace(coalesce(l.phone_e164, l.phone_raw, ''), '[^0-9]', '', 'g'), 8) = ANY ((SELECT public.report_excluded_phone8s())::text[])
   OR coalesce(l.webmaster, '(none)') = ANY (coalesce((SELECT array_agg(x) FROM public.app_settings s, jsonb_array_elements_text(CASE WHEN jsonb_typeof(s.value) = 'array' THEN s.value ELSE '[]'::jsonb END) x WHERE s.key = 'altercpa_rate_excluded_webmasters'), ARRAY[]::text[])))`;
const GEO = `coalesce((SELECT s.value #>> '{}' FROM public.app_settings s WHERE s.key = 'altercpa_rate_geo'), 'MK')`;
const inDays = (from, to) => `l.geo = ${GEO}
   AND coalesce(l.created_remote, l.first_seen_at) >= (${lit(from)}::date::timestamp AT TIME ZONE 'Europe/Skopje')
   AND coalesce(l.created_remote, l.first_seen_at) <  ((${lit(to)}::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje')`;

let RATES30 = [];

// ── G1 / G2: the bucket invariants ──────────────────────────────────────────
async function verifyBuckets(from, to) {
  const g1 = check('G1', 'leads = approved + cancel_other + cancelled + trashed + open (30 days, every grain)');
  const g2 = check('G2', 'counted = approved + cancel_other (30 days, every grain)');
  RATES30 = await timed('rates 30d', `SELECT * FROM public.altercpa_guarantee_rates(${lit(from)}, ${lit(to)})`);
  let bad1 = 0; let bad2 = 0;
  for (const r of RATES30) {
    if (n(r.leads) !== n(r.approved) + n(r.cancel_other) + n(r.cancelled) + n(r.trashed) + n(r.open)) bad1++;
    if (n(r.counted) !== n(r.approved) + n(r.cancel_other)) bad2++;
  }
  g1.tie(`rows breaking the invariant (of ${RATES30.length})`, 0, bad1);
  g2.tie(`rows breaking the invariant (of ${RATES30.length})`, 0, bad2);
  const grains = {};
  for (const r of RATES30) grains[r.grain] = (grains[r.grain] ?? 0) + 1;
  g1.info('rows per grain', grains);
}

// ── G3: day = Σ webmaster = Σ stream = Σ offer ─────────────────────────────
function verifyGrains() {
  const c = check('G3', 'the day grain = Σ webmaster = Σ (webmaster, stream) = Σ (webmaster, offer)');
  const key = (r) => r.day;
  const sums = { webmaster: new Map(), stream: new Map(), offer: new Map() };
  const days = new Map();
  for (const r of RATES30) {
    if (r.grain === 'day') { days.set(key(r), r); continue; }
    const m = sums[r.grain];
    const cur = m.get(key(r)) ?? Object.fromEntries(COLS.map((k) => [k, 0]));
    for (const k of COLS) cur[k] += n(r[k]);
    m.set(key(r), cur);
  }
  let bad = [];
  for (const [d, row] of days) {
    for (const g of ['webmaster', 'stream', 'offer']) {
      const s = sums[g].get(d) ?? Object.fromEntries(COLS.map((k) => [k, 0]));
      for (const k of COLS) if (n(row[k]) !== s[k]) bad.push(`${d} ${g}.${k}: day ${n(row[k])} ≠ Σ ${s[k]}`);
    }
  }
  c.tie(`mismatches over ${days.size} days`, 0, bad.length);
  if (bad.length) c.info('first mismatches', bad.slice(0, 8));
}

// ── G4: need_confirm ────────────────────────────────────────────────────────
async function verifyNeed(target) {
  const c = check('G4', 'altercpa_need_confirm() = max(0, ceil(target·N/100) − C), integers');
  const cohorts = RATES30.filter((r) => r.grain === 'day' || r.grain === 'webmaster');
  const pairs = cohorts.map((r) => [n(r.counted), n(r.leads)]);
  for (let N = 0; N <= 400; N++) for (const C of [0, 7, 21, 60]) pairs.push([C, N]);
  pairs.push([0, 70], [20, 70], [21, 70], [50, 157], [8, 40], [3, 10]);
  const values = pairs.map(([C, N]) => `(${C}, ${N})`).join(',');
  const rows = await timed('need_confirm grid', `
    SELECT v.c, v.n, public.altercpa_need_confirm(v.c, v.n, ${Number(target)}) AS need
    FROM (VALUES ${values}) AS v(c, n)`);
  let bad = 0;
  for (const r of rows) if (n(r.need) !== needOf(n(r.c), n(r.n), target)) bad++;
  c.tie(`mismatches over ${rows.length} pairs (${cohorts.length} live cohorts)`, 0, bad);
  const at = (C, N) => n(rows.find((r) => n(r.c) === C && n(r.n) === N)?.need);
  c.tie('N 70, C 0 → need 21 (the 0.3·70 float trap)', 21, at(0, 70));
  c.tie('N 157, C 50 → need 0', 0, at(50, 157));
  c.tie('N 40, C 8 → need 4', 4, at(8, 40));
  c.tie('N 10, C 3 → need 0 (exactly 30%)', 0, at(3, 10));
}

// ── G5 / G6: September against an independent recount ─────────────────────
async function verifySeptember() {
  const g5 = check('G5', 'September test leads: rates.test_excluded = a recount on altercpa_leads (≈ 76)');
  const g6 = check('G6', 'September totals: rates = a recount on altercpa_leads (5.754 raw / 2.044 counted on 01.10)');
  const [r] = await timed('september rates', `
    SELECT sum(leads)::int AS leads, sum(test_excluded)::int AS test, sum(counted)::int AS counted,
           sum(approved)::int AS approved, sum(cancel_other)::int AS cancel_other, sum(open)::int AS open
    FROM public.altercpa_guarantee_rates('2026-09-01', '2026-09-30') WHERE grain = 'day'`);
  const [x] = await timed('september recount', `
    SELECT count(*)::int AS raw,
           count(*) FILTER (WHERE ${TEST_PRED})::int AS test,
           count(*) FILTER (WHERE NOT ${TEST_PRED} AND l.decision IN ('approved', 'cancel_other'))::int AS counted,
           count(*) FILTER (WHERE NOT ${TEST_PRED} AND l.decision = 'approved')::int AS approved,
           count(*) FILTER (WHERE NOT ${TEST_PRED} AND l.decision = 'cancel_other')::int AS cancel_other,
           count(*) FILTER (WHERE NOT ${TEST_PRED} AND l.decision IS NULL)::int AS open,
           count(*) FILTER (WHERE l.decision IN ('approved', 'cancel_other'))::int AS counted_raw
    FROM public.altercpa_leads l WHERE ${inDays('2026-09-01', '2026-09-30')}`);
  g5.tie('test_excluded', n(x.test), n(r.test));
  g5.info('test leads (reference 76)', n(r.test));
  g6.tie('leads + test = raw', n(x.raw), n(r.leads) + n(r.test));
  g6.tie('counted (not test)', n(x.counted), n(r.counted));
  g6.tie('approved', n(x.approved), n(r.approved));
  g6.tie('cancel_other', n(x.cancel_other), n(r.cancel_other));
  g6.tie('open', n(x.open), n(r.open));
  const pct = (a, b) => (b ? `${((100 * a) / b).toFixed(1)}%` : '—');
  g6.info('raw (reference 5.754 · 2.044 · 35,5%)', `${n(x.raw)} · ${n(x.counted_raw)} · ${pct(n(x.counted_raw), n(x.raw))}`);
  g6.info('test excluded (reference ≈ 36,0%)', `${n(r.leads)} · ${n(r.counted)} · ${pct(n(r.counted), n(r.leads))}`);
}

// ── G7: the list = the counts for one day ──────────────────────────────────
async function verifyJournal(day) {
  const c = check('G7', `Лидови = Стапки for ${day}: total with test = leads + test_excluded; per decision`);
  const [r] = await timed('day rates', `SELECT * FROM public.altercpa_guarantee_rates(${lit(day)}, ${lit(day)}) WHERE grain = 'day'`);
  const rates = r ?? Object.fromEntries(COLS.map((k) => [k, 0]));
  const j = async (decision, test) => {
    const [row] = await runSql(`SELECT public.altercpa_guarantee_journal(${lit(day)}, ${lit(day)}, NULL, NULL, NULL, ${decision ? lit(decision) : 'NULL'}, NULL, ${test}, 1, 0) ->> 'total' AS total`);
    return n(row?.total);
  };
  const t0 = Date.now();
  c.tie('journal total with test', n(rates.leads) + n(rates.test_excluded), await j(null, true));
  c.tie('journal total without test', n(rates.leads), await j(null, false));
  for (const d of DECISIONS) c.tie(`decision ${d}`, n(rates[d]), await j(d, false));
  timings.push({ label: 'journal ×7', ms: Date.now() - t0 });
  const [open] = await runSql(`SELECT count(*)::int AS n FROM public.altercpa_guarantee_open(${lit(day)}, ${lit(day)}, 2000)`);
  c.tie('altercpa_guarantee_open rows = open', n(rates.open), n(open?.n));
}

// ── G8: alerts v2 + the index ───────────────────────────────────────────────
async function verifyAlerts() {
  const c = check('G8', 'alerts v2 (20260944000300): old triggers gone, new cron, limits; arrival index valid');
  const [idx] = await runSql(`
    SELECT coalesce(bool_and(i.indisvalid), false) AS valid, count(*)::int AS n
    FROM pg_index i JOIN pg_class x ON x.oid = i.indexrelid WHERE x.relname = 'idx_altercpa_leads_geo_arrival'`);
  c.tie('idx_altercpa_leads_geo_arrival present and VALID', { valid: true, n: 1 }, { valid: idx.valid, n: n(idx.n) });
  const [st] = await runSql(`
    SELECT to_regprocedure('public.altercpa_guarantee_sweep()') IS NOT NULL AS sweep,
           (SELECT count(*)::int FROM pg_trigger WHERE tgname IN ('trg_altercpa_lead_rate', 'trg_altercpa_confirm_rate')) AS old_triggers,
           (SELECT count(*)::int FROM cron.job WHERE jobname = 'altercpa-guarantee-sweep') AS new_cron,
           (SELECT count(*)::int FROM cron.job WHERE jobname = 'altercpa-rate-verdicts') AS old_cron,
           (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = 'altercpa_rate_alerts_kind_check') AS kind_check`);
  if (!st.sweep) {
    c.info('20260944000300 not applied yet', `old triggers ${st.old_triggers} · old cron ${st.old_cron}`);
    return;
  }
  c.tie('old triggers', 0, n(st.old_triggers));
  c.tie('cron altercpa-guarantee-sweep', 1, n(st.new_cron));
  c.tie('cron altercpa-rate-verdicts', 0, n(st.old_cron));
  c.tie('kind CHECK knows digest / unreachable / verdict_close', true,
    ['digest', 'unreachable', 'verdict_close'].every((k) => String(st.kind_check).includes(`'${k}'`)));
  // Limits per Skopje day: one digest; one unreachable / verdict_close per webmaster.
  const rows = await runSql(`
    SELECT cohort_date::text AS day, kind, webmaster, count(*)::int AS n
    FROM public.altercpa_rate_alerts
    WHERE kind IN ('digest', 'unreachable', 'verdict_close', 'verdict_final') AND created_at > now() - interval '14 days'
    GROUP BY 1, 2, 3 HAVING count(*) > 1`);
  c.tie('duplicate alerts (day, kind, webmaster) in 14 days', 0, rows.length);
  const [per] = await runSql(`
    SELECT coalesce(max(k), 0)::int AS max_per_user_day FROM (
      SELECT n.user_id, (n.created_at AT TIME ZONE 'Europe/Skopje')::date, count(*) AS k
      FROM public.notifications n
      WHERE n.meta ->> 'i18n' LIKE 'notif.altercpaGuarantee%' AND n.created_at > now() - interval '14 days'
      GROUP BY 1, 2) s`);
  const cap = 1 + 2 * 8;   // a digest + (unreachable + close) for ≤ 8 webmasters ≥ min_cohort
  const got = n(per.max_per_user_day);
  if (got > cap) c.tie(`guarantee notifications per person per day ≤ ${cap}`, `≤ ${cap}`, got);
  else c.info('max guarantee notifications per person per day (14 days)', got);
}

async function main() {
  const json = process.argv.includes('--json');
  const di = process.argv.indexOf('--day');
  let day = di > 0 ? process.argv[di + 1] : null;
  if (day && !YMD.test(day)) { console.error('verify-altercpa-guarantee: --day YYYY-MM-DD'); process.exit(2); }
  const [have] = await runSql(`
    SELECT to_regprocedure('public.altercpa_guarantee_rates(date,date)') IS NOT NULL AS rates,
           to_regprocedure('public.altercpa_guarantee_journal(date,date,text,text,text,text,text,boolean,integer,integer)') IS NOT NULL AS journal,
           to_regprocedure('public.altercpa_need_confirm(integer,integer,numeric)') IS NOT NULL AS need,
           (now() AT TIME ZONE 'Europe/Skopje')::date::text AS today,
           coalesce((SELECT (value #>> '{}')::numeric FROM public.app_settings WHERE key = 'altercpa_rate_target_pct'), 30) AS target`);
  const missing = ['rates', 'journal', 'need'].filter((k) => !have[k]);
  if (missing.length) {
    console.error(`verify-altercpa-guarantee: not applied yet (${missing.join(', ')}) — apply 20260944000210 first`);
    process.exit(2);
  }
  day = day ?? have.today;
  const to = have.today;
  const from = new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);

  await verifyBuckets(from, to);
  verifyGrains();
  await verifyNeed(n(have.target));
  await verifySeptember();
  await verifyJournal(day);
  await verifyAlerts();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-altercpa-guarantee', read_only: true, generated_at: new Date().toISOString(), day, status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log(`verify-altercpa-guarantee · read-only · Macedonia · ${from} … ${to} · G7 day ${day}`);
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
        else console.log(`        ✓ ${l.label}: ${JSON.stringify(l.got)}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-altercpa-guarantee error: ${e?.message ?? e}`); process.exit(2); });
