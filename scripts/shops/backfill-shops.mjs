#!/usr/bin/env node
/**
 * backfill-shops — the shops history (collabbox-shops, docs/SHOPS.md "Backfill"), DRY BY DEFAULT.
 *
 *   node scripts/shops/backfill-shops.mjs                      the PLAN (read-only): what the night backfill has done,
 *                                                              what is left, and what the next chunk reads + its requests
 *   node scripts/shops/backfill-shops.mjs --apply [--chunks=3] run that many backfill chunks NOW through the deployed
 *                                                              edge function (one at a time, each waited for)
 *     --any-hour     allow --apply outside 21:00–06:30 Skopje (collabBox is the shops' live till system; the
 *                    collabbox-sync rule: never run a manual backfill into 07:00)
 *
 * The backfill itself lives in the edge function (mode 'backfill'): it is RESUMABLE by construction — every
 * day / week / month it reads is written to public.shops_backfill_log and never read again. This script never
 * talks to collabBox and never writes the database itself: --apply only POSTs {mode:'backfill'} to the function
 * (header x-collabbox-sync-secret = $COLLABBOX_SYNC_SECRET, the same secret collabbox-sync uses) and follows the
 * run in public.shops_reader_runs (read-only SQL). The function keeps one run at a time (409) and refuses while
 * collabbox-sync runs.
 *
 * What one chunk reads (app_settings.shops_reader.backfill; requests ≤ max_requests, 330 s):
 *   1. yesterday closed — its receipts once more + 10018 + the trade book (4 requests)
 *   2. receipt days from sales_from, oldest first, up to sales_days_per_run (1 request a day)
 *   3. the 10018 reports of closed months (1 request a month, ≤ 3)
 *   4. goods documents a week at a time from docs_from (2 requests a week, ≤ 4)
 *   5. lnp per shop and closed month from lnp_from, up to lnp_per_run (~30 s each on their side)
 *
 * Safety: Macedonia only — the read-only guard of scripts/verify-insights-ties.mjs; --apply first runs
 * scripts/assert-mk-target.mjs and refuses when it fails.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSql } from '../verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FN_URL = 'https://oufoazmnbwugtfldkwsn.supabase.co/functions/v1/collabbox-shops';
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const has = (name) => process.argv.includes(`--${name}`);
const n = (v) => Number(v ?? 0) || 0;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const addDays = (ymd, k) => new Date(Date.parse(ymd + 'T00:00:00Z') + k * 86_400_000).toISOString().slice(0, 10);

async function plan() {
  const [h] = await runSql(`
    SELECT to_regclass('public.shops_backfill_log') IS NOT NULL AS ok,
           (now() AT TIME ZONE 'Europe/Skopje')::date AS today,
           to_char(now() AT TIME ZONE 'Europe/Skopje', 'HH24:MI') AS now_hm`);
  if (!h.ok) { console.error('backfill-shops: the shops tables are missing — apply 20260946000100 first'); process.exit(2); }
  const [s] = await runSql(`SELECT value FROM public.app_settings WHERE key = 'shops_reader'`);
  const set = s?.value ?? {};
  const b = set.backfill ?? {};
  const today = String(h.today).slice(0, 10);
  const yesterday = addDays(today, -1);
  const salesFrom = b.sales_from ?? '2026-01-01';
  const docsFrom = b.docs_from ?? '2026-01-01';
  const lnpFrom = b.lnp_from ?? '2025-01';
  const log = await runSql(`SELECT kind, count(*) AS n, min(key) AS first, max(key) AS last, max(done_at) AS last_at
                              FROM public.shops_backfill_log WHERE ok GROUP BY kind ORDER BY kind`);
  const done = new Set((await runSql(`SELECT kind || ':' || key AS k FROM public.shops_backfill_log WHERE ok`)).map((r) => r.k));
  const [shops] = await runSql(`SELECT count(*) FILTER (WHERE active) AS n FROM public.shops`);
  const days = [];
  for (let d = salesFrom; d < yesterday; d = addDays(d, 1)) if (!done.has(`sales_day:${d}`) && !done.has(`close_day:${d}`)) days.push(d);
  const months = [];
  for (let y = Number(lnpFrom.slice(0, 4)), m = Number(lnpFrom.slice(5, 7)); ; ) {
    const ym = `${y}-${String(m).padStart(2, '0')}`;
    if (ym >= today.slice(0, 7)) break;
    months.push(ym);
    m++; if (m > 12) { m = 1; y++; }
  }
  const lnpLeft = months.length * n(shops.n) - (log.find((r) => r.kind === 'lnp_month')?.n ?? 0);
  const perRun = Math.max(1, n(b.sales_days_per_run) || 25);
  const lnpPerRun = Math.max(0, n(b.lnp_per_run ?? 4));
  console.log('backfill-shops · Macedonia · plan (read-only)');
  console.log(`  switch: reader ${set.enabled ? 'ON' : 'off'} · backfill ${b.enabled ? 'ON' : 'off'} · max ${b.max_requests ?? 60} requests a chunk`);
  console.log(`  windows: receipts from ${salesFrom} · goods from ${docsFrom} · lnp from ${lnpFrom}`);
  for (const r of log) console.log(`  done ${r.kind.padEnd(14)} ${String(r.n).padStart(4)}  ${r.first} … ${r.last}  (last ${String(r.last_at).slice(0, 16)})`);
  if (!log.length) console.log('  done: nothing yet');
  console.log(`  left: ${days.length} receipt days · ${lnpLeft} shop-months of lnp · yesterday closed: ${done.has(`close_day:${yesterday}`) ? 'yes' : 'no'}`);
  const next = days.slice(0, perRun);
  console.log(`  next chunk: ${done.has(`close_day:${yesterday}`) ? '' : `close ${yesterday} (4 req) · `}${next.length ? `receipts ${next[0]} … ${next.at(-1)} (${next.length} req)` : 'no receipt days'}` +
    ` · ≤ 3 control months · ≤ 4 goods weeks (≤ 8 req) · ≤ ${lnpPerRun} lnp`);
  const chunks = Math.ceil(days.length / perRun);
  console.log(`  ≈ ${chunks} chunk(s) for the receipts, ≈ ${lnpPerRun ? Math.ceil(lnpLeft / lnpPerRun) : '∞'} for lnp (11 chunks a night, 00:30–05:30)`);
  return { set, today, nowHm: String(h.now_hm) };
}

async function apply(p) {
  const secret = process.env.COLLABBOX_SYNC_SECRET;
  if (!secret) { console.error('backfill-shops: set COLLABBOX_SYNC_SECRET (the collabbox-sync header secret) to --apply'); process.exit(2); }
  const hm = p.nowHm;
  if (!has('any-hour') && hm > '06:30' && hm < '21:00') {
    console.error(`backfill-shops: ${hm} Skopje — the shops are open; run between 21:00 and 06:30 or pass --any-hour`);
    process.exit(2);
  }
  const trip = spawnSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { encoding: 'utf8' });
  if (trip.status !== 0) { console.error('backfill-shops: assert-mk-target failed — refusing\n' + (trip.stdout || '') + (trip.stderr || '')); process.exit(2); }
  const chunks = Math.min(20, Math.max(1, Number(arg('chunks')) || 1));
  for (let i = 1; i <= chunks; i++) {
    const res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'x-collabbox-sync-secret': secret, 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'backfill', trigger: 'manual' }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) { console.log(`chunk ${i}: busy (${body.skipped}) — waiting 60 s`); await pause(60_000); i--; continue; }
    if (res.status !== 202 || !/^[0-9a-f-]{36}$/i.test(String(body.run_id ?? ""))) { console.error(`chunk ${i}: HTTP ${res.status} ${JSON.stringify(body).slice(0, 300)}`); process.exit(1); }
    console.log(`chunk ${i}: run ${body.run_id} started`);
    let run;
    for (;;) {
      await pause(10_000);
      [run] = await runSql(`SELECT status, requests, warning, error, stats->'backfill' AS b FROM public.shops_reader_runs WHERE id = '${body.run_id}'`);
      if (run && run.status !== 'running') break;
    }
    console.log(`chunk ${i}: ${run.status} · ${run.requests} requests · ${JSON.stringify(run.b)}${run.warning ? ' · ' + run.warning : ''}${run.error ? ' · ' + run.error : ''}`);
    if (run.status === 'failed') process.exit(1);
    const left = run.b?.sales_days?.left ?? 0;
    if (!left && !(run.b?.lnp?.left > 0) && !(run.b?.docs_weeks?.length)) { console.log('nothing left'); break; }
    if (i < chunks) await pause(30_000);
  }
}

const p = await plan();
if (has('apply')) await apply(p);
else console.log('\n(dry run — nothing was read from collabBox, nothing was written; --apply runs chunks through the function)');
