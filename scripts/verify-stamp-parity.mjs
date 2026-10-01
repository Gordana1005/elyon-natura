#!/usr/bin/env node
/**
 * Parity gate for the seller-stamping cron (READ-ONLY, Macedonia only).
 *
 *   node scripts/verify-stamp-parity.mjs
 *
 * Compares, row by row on live MK data:
 *   1. order_decider_plan()'s body (the NEWEST migration that defines it — 20260939000300, re-emitted
 *      by 20260944001200 — run inline, so this works BEFORE the migration is applied) with
 *      scripts/backfill-order-deciders.mjs planPageSql, over every unstamped real sale;
 *   2. the same over every real sale INCLUDING already-stamped ones (scope marker swapped);
 *   3. the re-derived stamp of every stamped order with what orders.sold_* holds now.
 * Expected: 0 row diffs in 1 and 2 (the two are KEEP-IN-STEP twins), and 3 "differ" = 0 apart
 * from rows a human changed after stamping. sold_at may differ below 1 ms (the script
 * round-trips through a JS Date; the function keeps microseconds). Exit code 1 on any diff.
 *
 * Guards: scripts/lib/repair-kit.mjs mkGuard + assertRemoteIsMk (never Bulgaria), read_only.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mkGuard, sqlRead, assertRemoteIsMk } from './lib/repair-kit.mjs';
import { planPageSql } from './backfill-order-deciders.mjs';

// The NEWEST migration that (re)defines order_decider_plan — 20260939000300 first, re-emitted by
// 20260944001200 (owner 01.10.2026: a first sale step counts only from a person or with the parcel
// still there). Run inline, so the twins are proven equal before the migration is applied.
const MIG_DIR = new URL('../supabase/migrations/', import.meta.url);
const DEF = 'CREATE OR REPLACE FUNCTION public.order_decider_plan(';
const MIG_FILE = readdirSync(fileURLToPath(MIG_DIR)).filter((f) => f.endsWith('.sql')).sort()
  .filter((f) => readFileSync(new URL(f, MIG_DIR), 'utf8').includes(DEF)).pop();
const src = readFileSync(new URL(MIG_FILE, MIG_DIR), 'utf8');
const start = src.indexOf(DEF);
const bodyStart = src.indexOf('AS $fn$', start) + 'AS $fn$'.length;
const bodyEnd = src.indexOf('$fn$;', bodyStart);
const planBody = src.slice(bodyStart, bodyEnd).trim().replace(/;\s*$/, '');

const SINCE = "interval '10 years'";
const fnSql = (withStamped) => {
  let b = planBody.replaceAll('p_since', SINCE);
  if (withStamped) {
    if (!b.includes('WHERE o.sold_at IS NULL /*SCOPE_SOLD*/')) throw new Error('scope marker missing');
    b = b.replace('WHERE o.sold_at IS NULL /*SCOPE_SOLD*/', 'WHERE true');
  }
  return `SELECT order_id::text AS id, action, rule, via, sold_at, person_id::text AS person_id, ext, bucket FROM (${b}) z WHERE action <> 'fill_person'`;
};
const scriptSql = (after, withStamped) => {
  let s = planPageSql(after, 5000);
  if (withStamped) {
    const before = s;
    s = s.replace(/WHERE o\.sold_at IS NULL\n/, 'WHERE true\n');
    if (s === before) throw new Error('script scope clause not found');
  }
  return s;
};

const key = (r) => [r.rule ?? '', r.via ?? '', r.person_id ?? '', r.ext ?? '', r.bucket ?? '',
  r.sold_at ? new Date(r.sold_at).toISOString() : ''].join('|');

async function scriptPlan(withStamped) {
  const rows = new Map();
  let after = null;
  for (;;) {
    const [pg] = await sqlRead(scriptSql(after, withStamped));
    for (const r of pg.rows || []) rows.set(r.id, r);
    if (!pg.page_n || pg.page_n < 5000) break;
    after = pg.page_last;
  }
  return rows;
}

async function compare(withStamped) {
  const label = withStamped ? 'ALL real sales incl. stamped' : 'unstamped (what the cron sees)';
  const t0 = Date.now();
  const fnRows = new Map((await sqlRead(fnSql(withStamped))).map((r) => [r.id, r]));
  const scRows = await scriptPlan(withStamped);
  let diffs = 0; const ex = [];
  const ids = new Set([...fnRows.keys(), ...scRows.keys()]);
  for (const id of ids) {
    const a = fnRows.get(id); const b = scRows.get(id);
    if (!a || !b || key(a) !== key(b)) {
      // sold_at: the script round-trips through JS Date (ms); allow < 1 ms
      if (a && b && a.rule === b.rule && a.via === b.via && a.person_id === b.person_id && a.ext === b.ext
          && (a.bucket ?? '') === (b.bucket ?? '')
          && Math.abs(new Date(a.sold_at) - new Date(b.sold_at)) < 1) continue;
      diffs++; if (ex.length < 10) ex.push({ id, fn: a, script: b });
    }
  }
  const byRule = {};
  for (const r of fnRows.values()) byRule[r.rule ?? 'unresolved'] = (byRule[r.rule ?? 'unresolved'] || 0) + 1;
  console.log(`\n${label}: fn ${fnRows.size} · script ${scRows.size} · row diffs ${diffs} (${Date.now() - t0} ms)`);
  console.log('  by rule:', JSON.stringify(byRule));
  if (ex.length) console.log('  examples:', JSON.stringify(ex, null, 1).slice(0, 4000));
  return { fnRows, diffs };
}

async function storedVsDerived(fnRows) {
  const stored = await sqlRead(`SELECT id::text AS id, sold_at, sold_via, sold_by_ext, sold_by_person_id::text AS person_id
      FROM public.orders WHERE sold_at IS NOT NULL`);
  let same = 0, differ = 0, notInPlan = 0; const ex = [];
  for (const s of stored) {
    const d = fnRows.get(s.id);
    if (!d) { notInPlan++; continue; }
    const ok = d.via === s.sold_via && (d.ext ?? null) === (s.sold_by_ext ?? null)
      && (s.person_id == null || d.person_id === s.person_id)
      && d.sold_at && Math.abs(new Date(d.sold_at) - new Date(s.sold_at)) < 1;
    if (ok) same++; else { differ++; if (ex.length < 10) ex.push({ id: s.id, stored: s, derived: d }); }
  }
  console.log(`\nstored stamps: ${stored.length} · re-derived equal ${same} · differ ${differ} · not in plan (live trigger / later edits) ${notInPlan}`);
  if (ex.length) console.log('  examples:', JSON.stringify(ex, null, 1).slice(0, 4000));
}

mkGuard();
await assertRemoteIsMk();
console.log(`order_decider_plan body from supabase/migrations/${MIG_FILE}`);
const [live] = await sqlRead(`select position('holds_parcel' in prosrc) > 0 as first_sale_proof
  from pg_proc where oid = to_regprocedure('public.order_decider_plan(interval)')`);
console.log(`live function: ${live?.first_sale_proof ? 'carries' : 'does NOT carry yet'} the 20260944001200 first-sale-proof rule`);
const a = await compare(false);
const b = await compare(true);
await storedVsDerived(b.fnRows);
const okAll = a.diffs === 0 && b.diffs === 0;
console.log(okAll ? '\nPARITY OK' : '\nPARITY FAILED');
if (!okAll) process.exit(1);
