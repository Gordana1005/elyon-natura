/**
 * verify-booking-day — READ-ONLY proof that a collabBox sale counts on the day the operator BOOKED it
 * (owner 01.10.2026; migrations 20260944000500 / 000600, collabbox-sync ahead_days, the backfill
 * scripts/backfill-collabbox-booked-at.mjs).
 *
 *   node scripts/verify-booking-day.mjs [--day YYYY-MM-DD] [--export <orders_ALL_combined.csv>] [--json]
 *
 *   B1  every waiting / created document has booked_at (after the backfill; before it, the rows the
 *       ledger held before 20260944000500 are counted and reported as WARN)
 *   B2  booked_at ≤ doc_at, and a basis on every booked_at
 *   B3  the board = the cohort for the day: leaderboard_day_v2's day_totals per department (orders +
 *       bookings + web + MEX-only) = insights_sale_rows' in-total rows per department; its bookings =
 *       the cohort's booking rows; checks.bookings_filter_drift = 0; and no MEX-only parcel of the day
 *       is a document still counted as a booking (the 07:37–07:50 morning gap)
 *   B4  no booking dated ahead is missing: (a) the last frequent pass read the ahead range
 *       (collabbox_sync_runs.ahead_to ≥ today + 14) during the working day; (b) every order-type
 *       document dated after today in the local collabBox export (the current-state folder,
 *       collab_out) is in the ledger — read from the FILE, collabBox itself is never called
 *   info  the bases of the day's documents, the sale-day split of today's bookings
 *
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = refused / unreachable / the migration is not applied.
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia, a single
 * SELECT / WITH per statement, sent with read_only: true; the token is never printed.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const ORDER_TYPES = ['10036', '10050', '10106', '10114', '10111'];
const DEFAULT_EXPORT = 'C:/Users/Mile/collab_out/09-site-nalozi-zaedno/orders_ALL_combined.csv';
const YMD = /^\d{4}-\d{2}-\d{2}$/;
const skopjeToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
const addDays = (ymd, k) => new Date(Date.parse(`${ymd}T00:00:00Z`) + k * 864e5).toISOString().slice(0, 10);
const n = (v) => Number(v ?? 0) || 0;
const parseJson = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function parseArgs(argv) {
  const out = { day: null, exportPath: DEFAULT_EXPORT, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--day') out.day = argv[++i];
    else if (a === '--export') out.exportPath = argv[++i];
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  out.day = out.day ?? skopjeToday();
  if (!YMD.test(out.day)) throw new Error('--day must be YYYY-MM-DD');
  return out;
}

/** "dd.mm.yyyy …" CSV cells → the order-type documents dated after `today` (simple quoted CSV). */
export function aheadDocsFromCsv(text, today) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const parse = (l) => { const o = []; let c = '', q = false; for (let i = 0; i < l.length; i++) { const ch = l[i]; if (q) { if (ch === '"') { if (l[i + 1] === '"') { c += '"'; i++; } else q = false; } else c += ch; } else if (ch === '"') q = true; else if (ch === ',') { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
  const hdr = parse(lines[0] ?? '');
  const iTip = hdr.indexOf('TipID'), iDat = hdr.indexOf('Datum'), iNum = hdr.indexOf('DocNumber');
  if (iTip < 0 || iDat < 0 || iNum < 0) return null;
  const out = [];
  for (const l of lines.slice(1)) {
    if (!l) continue;
    const f = parse(l);
    const m = String(f[iDat] ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!m) continue;
    const iso = `${m[3]}-${m[2]}-${m[1]}`;
    if (iso > today && ORDER_TYPES.includes(String(f[iTip]).trim())) out.push({ doc: String(f[iNum]).trim(), day: iso, type: String(f[iTip]).trim() });
  }
  return out;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
  const [s] = await runSql(`SELECT to_regprocedure('public.collabbox_sale_at(timestamptz,timestamptz)') IS NOT NULL AS sale_at,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collabbox_documents' AND column_name = 'booked_at') AS col,
      EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'collabbox_sync_runs' AND column_name = 'ahead_to') AS ahead,
      (SELECT max(r.applied_at) FROM public.data_repair_runs r WHERE r.key = 'collabbox-booked-at' AND r.applied_at IS NOT NULL) AS backfill_at`);
  if (!s.sale_at || !s.col || !s.ahead) {
    console.error('20260944000500 / 000600 are not applied — nothing to verify yet.');
    process.exit(2);
  }
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });
  const day = args.day;
  const f = `('${day}'::date::timestamp AT TIME ZONE 'Europe/Skopje')`;
  const t = `((('${day}'::date + 1)::timestamp AT TIME ZONE 'Europe/Skopje') - interval '1 microsecond')`;

  // B1
  const [b1] = await runSql(`SELECT count(*) FILTER (WHERE d.booked_at IS NULL)::int AS missing,
      count(*) FILTER (WHERE d.booked_at IS NULL AND d.first_seen_at >= (SELECT min(r.started_at) FROM public.collabbox_sync_runs r WHERE r.ahead_to IS NOT NULL))::int AS missing_new,
      count(*)::int AS total
    FROM public.collabbox_documents d WHERE d.outcome IN ('booked', 'awaiting_parcel', 'created')`);
  if (n(b1.missing_new) > 0) add('B1', 'every waiting / created document has booked_at', 'FAIL', `${b1.missing_new} documents first seen since the ahead passes have none`);
  else if (n(b1.missing) > 0) add('B1', 'every waiting / created document has booked_at', s.backfill_at ? 'FAIL' : 'WARN', `${b1.missing} of ${b1.total} without one${s.backfill_at ? '' : ' — the backfill has not been applied yet'}`);
  else add('B1', 'every waiting / created document has booked_at', 'PASS', `${b1.total} documents`);

  // B2
  const [b2] = await runSql(`SELECT count(*) FILTER (WHERE d.booked_at > d.doc_at)::int AS after_doc,
      count(*) FILTER (WHERE d.booked_at IS NOT NULL AND d.booked_at_basis IS NULL)::int AS no_basis,
      count(*) FILTER (WHERE d.booked_at IS NOT NULL)::int AS decided
    FROM public.collabbox_documents d`);
  add('B2', 'booked_at ≤ doc_at, every one with a basis', n(b2.after_doc) + n(b2.no_basis) === 0 ? 'PASS' : 'FAIL',
    `${b2.decided} decided · ${b2.after_doc} after doc_at · ${b2.no_basis} without a basis`);

  // B3
  const coh = await runSql(`SELECT r.kind, r.source, count(*)::int AS n, round(sum(r.value_mkd))::bigint AS v
    FROM public.insights_sale_rows(${f}, ${t}, false) r WHERE r.in_total GROUP BY 1, 2`);
  const [lb] = await runSql(`SELECT public.leaderboard_day_v2('${day}'::date, NULL::text, NULL::text) AS doc`);
  const doc = parseJson(lb.doc);
  const bad = [];
  for (const [dept, x] of Object.entries(doc.day_totals?.by_department ?? {})) {
    const board = n(x.sales) + n(x.booked) + n(x.web) + n(x.mex_only);
    const cohort = coh.filter((r) => r.source === dept).reduce((a, r) => a + n(r.n), 0);
    const bk = coh.filter((r) => r.source === dept && r.kind === 'booking').reduce((a, r) => a + n(r.n), 0);
    if (board !== cohort) bad.push(`${dept}: board ${board} ≠ cohort ${cohort}`);
    if (n(x.booked) !== bk) bad.push(`${dept}: board bookings ${x.booked} ≠ cohort bookings ${bk}`);
  }
  const drift = n(doc.day_totals?.checks?.bookings_filter_drift);
  if (drift !== 0) bad.push(`bookings_filter_drift ${drift}`);
  // a parcel counted MEX-only while its document is a booking (of any day) — the 07:37–07:50 gap
  const [gap] = await runSql(`WITH b AS (
      SELECT r.display_id FROM public.insights_sale_rows(now() - interval '15 days', now(), false) r WHERE r.kind = 'booking')
    SELECT count(*)::int AS n FROM public.insights_sale_rows(${f}, ${t}, false) r
     WHERE r.kind = 'mex' AND r.display_id IN (SELECT b.display_id FROM b)`);
  if (n(gap.n) > 0) bad.push(`${gap.n} MEX-only parcels whose document is still waiting (the morning gap)`);
  add('B3', `the board = the cohort on ${day}`, bad.length ? 'FAIL' : 'PASS', bad.length ? bad.join('; ') : `${coh.reduce((a, r) => a + n(r.n), 0)} sales, bookings ${doc.summary?.booked ?? 0}, drift 0`);

  // B4
  const today = skopjeToday();
  const [run] = await runSql(`SELECT r.status, r.window_to::text AS wt, r.ahead_to::text AS at,
      to_char(r.started_at AT TIME ZONE 'Europe/Skopje', 'DD.MM HH24:MI') AS st,
      (now() - r.started_at) < interval '40 minutes' AS recent
    FROM public.collabbox_sync_runs r WHERE r.kind = 'manual' AND r.trigger_kind = 'cron' AND r.status IN ('ok', 'partial')
    ORDER BY r.started_at DESC LIMIT 1`);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const working = hour >= 7 && hour < 23;
  if (!run) add('B4a', 'the frequent pass reads the ahead range', 'FAIL', 'no frequent pass at all');
  else if (!run.at) add('B4a', 'the frequent pass reads the ahead range', 'FAIL', `the last pass (${run.st}) read no ahead range — is collabbox-sync deployed, does the cron send ahead_days?`);
  else if (run.at < addDays(run.wt, 14)) add('B4a', 'the frequent pass reads the ahead range', 'WARN', `the last pass (${run.st}) read ahead only to ${run.at}`);
  else if (working && !run.recent) add('B4a', 'the frequent pass reads the ahead range', 'WARN', `the last pass with an ahead range started ${run.st} — not in the last 40 minutes`);
  else add('B4a', 'the frequent pass reads the ahead range', 'PASS', `last pass ${run.st}: ahead to ${run.at}`);
  if (!args.exportPath || !existsSync(args.exportPath)) {
    add('B4b', 'every booking dated ahead in the collabBox export is in the ledger', 'SKIP', `no export at ${args.exportPath}`);
  } else {
    const stamp = statSync(args.exportPath).mtime;
    const exportDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(stamp);
    const ahead = aheadDocsFromCsv(readFileSync(args.exportPath, 'utf8'), exportDay);
    if (!ahead) add('B4b', 'every booking dated ahead in the collabBox export is in the ledger', 'SKIP', 'the export has no TipID / Datum / DocNumber columns');
    else {
      const docs = [...new Set(ahead.map((a) => a.doc))].filter((d) => /^[0-9]{3}-[0-9]{4}-[0-9]+\/[0-9]{4}$/.test(d));
      const found = new Set();
      for (let i = 0; i < docs.length; i += 500) {
        const part = docs.slice(i, i + 500).map((d) => `'${d}'`).join(',');
        if (!part) continue;
        for (const r of await runSql(`SELECT d.doc_number FROM public.collabbox_documents d WHERE d.doc_number IN (${part})`)) found.add(r.doc_number);
      }
      const missing = docs.filter((d) => !found.has(d));
      const ran = run?.at && run.st;
      add('B4b', `every booking dated ahead in the collabBox export (${exportDay}) is in the ledger`,
        missing.length === 0 ? 'PASS' : (ran ? 'FAIL' : 'WARN'),
        `${docs.length} dated after ${exportDay}, ${missing.length} missing${missing.length ? ` (e.g. ${missing.slice(0, 5).join(', ')})` : ''}`);
    }
  }

  // info: the day's documents by basis, today's bookings by booking day
  const info = await runSql(`SELECT coalesce(d.booked_at_basis, 'NULL') AS basis, count(*)::int AS n,
      count(*) FILTER (WHERE public.collabbox_sale_at(d.doc_at, d.booked_at) <> d.doc_at)::int AS moved
    FROM public.collabbox_documents d WHERE d.doc_at >= ${f} AND d.doc_at <= ${t} + interval '14 days' GROUP BY 1 ORDER BY 1`);

  const fail = checks.some((c) => c.status === 'FAIL');
  if (args.json) {
    console.log(JSON.stringify({ day, checks, info, status: fail ? 'FAIL' : 'PASS' }, null, 2));
  } else {
    console.log(`\nverify-booking-day — ${day}${s.backfill_at ? ` · backfill applied ${s.backfill_at}` : ' · backfill NOT applied yet'}`);
    for (const c of checks) console.log(`  ${c.status.padEnd(4)} ${c.id.padEnd(4)} ${c.label} — ${c.detail}`);
    console.log(`  info documents dated ${day} … +14 by basis: ${info.map((r) => `${r.basis} ${r.n} (sale day moved ${r.moved})`).join(' · ')}`);
    console.log(fail ? '\nFAIL' : '\nPASS');
  }
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.message || e); process.exit(2); });
}
