/**
 * stock-run — one stock v2 run (stock_v2_apply) against the MACEDONIAN database, from a terminal.
 *
 *   node scripts/stock/stock-run.mjs                 DRY (default): what a run would write — totals by
 *                                                    kind + 50 samples; read-only, nothing written
 *   node scripts/stock/stock-run.mjs --apply         a real run (the switch must be ON — the function
 *                                                    answers {"status":"disabled"} otherwise)
 *   node scripts/stock/stock-run.mjs --json          the raw result
 *   node scripts/stock/stock-run.mjs --trigger=name  the trigger written into stock_runs (default manual)
 *
 * Exit: 0 = ok (or disabled on a dry run) · 1 = the run failed / was refused · 2 = guard refusal.
 *
 * Safety. Pinned to Macedonia (oufoazmnbwugtfldkwsn): supabase/config.toml must agree and .env must not
 * point at Bulgaria. The dry run is one SELECT sent with read_only: true through the guard of
 * scripts/verify-insights-ties.mjs. --apply first runs scripts/assert-mk-target.mjs (the tripwire) and
 * then sends exactly one whitelisted statement (SELECT public.stock_v2_apply(...) / stock_v2_reset(...))
 * with read_only: false. The access token is read from .env and never printed. The LEAD runs --apply.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runSql } from '../verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = 'oufoazmnbwugtfldkwsn';            // Macedonia — the ONLY project this script writes
const FORBIDDEN_REF = 'sxymaloycddnoxudxaqp';  // live Bulgaria — never
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;

export class Refusal extends Error {}

function loadToken() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const projectId = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (projectId !== REF) throw new Refusal(`supabase/config.toml project_id = "${projectId}", expected "${REF}" (Macedonia)`);
  const env = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    if (env[k]?.includes(FORBIDDEN_REF)) throw new Refusal(`.env ${k} points at LIVE BULGARIA — fix the workspace first`);
  }
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Refusal('SUPABASE_ACCESS_TOKEN not found in .env');
  return env.SUPABASE_ACCESS_TOKEN;
}

/** The ONLY statements the stock scripts may write with. */
const WRITE_WHITELIST = [
  /^SELECT public\.stock_v2_apply\('[a-z0-9_:-]{1,40}', false\) AS r$/,
  /^SELECT public\.stock_v2_reset\('[0-9a-f-]{36}'::uuid, '[^'\\]{5,500}'\) AS r$/,
];

/** Runs the tripwire, then ONE whitelisted write statement against Macedonia. */
export async function runWrite(sql) {
  if (sql.includes(FORBIDDEN_REF)) throw new Refusal('Bulgarian ref in SQL — refusing');
  if (!WRITE_WHITELIST.some((re) => re.test(sql))) throw new Refusal(`refusing a write that is not whitelisted: ${sql.slice(0, 120)}`);
  const trip = spawnSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { encoding: 'utf8' });
  if (trip.status !== 0) throw new Refusal(`tripwire refused:\n${trip.stdout ?? ''}${trip.stderr ?? ''}`);
  const token = loadToken();
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, read_only: false }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Management API ${res.status}: ${text.split(token).join('***').slice(0, 600)}`);
  return JSON.parse(text);
}

function printStats(r) {
  console.log(`status ${r.status}${r.dry ? ' (DRY — nothing written)' : ''}${r.run_id ? ` · run ${r.run_id}` : ''}${r.duration_ms != null ? ` · ${r.duration_ms} ms` : ''}`);
  if (r.error) console.log(`error: ${r.error}`);
  if (r.status !== 'ok') return;
  console.log(`groups ${r.groups}${r.moves != null ? ` · moves written ${r.moves}` : ''} · corrections ${r.corrections} · parcels ${r.parcels}`);
  console.log(`units out ${r.units_out} · units back ${r.units_back}${r.parcel_states_changed != null ? ` · parcel states changed ${r.parcel_states_changed}` : ''}`);
  const kinds = Object.entries(r.by_kind ?? {}).sort((a, b) => Math.abs(b[1].qty) - Math.abs(a[1].qty));
  if (kinds.length) {
    console.log('\nby kind:');
    for (const [k, v] of kinds) console.log(`  ${k.padEnd(15)} rows ${String(v.rows).padStart(6)}   qty ${String(v.qty).padStart(10)}`);
  }
  if ((r.samples ?? []).length) {
    console.log('\nsamples (largest first):');
    for (const s of r.samples.slice(0, 50)) {
      console.log(`  ${String(s.delta).padStart(8)} ${s.kind.padEnd(13)} ${s.article_code} @${s.warehouse} ${String(s.event_at).slice(0, 16)} ${s.source_key}${s.correction ? ' (correction)' : ''}`);
    }
  }
}

async function main() {
  const apply = process.argv.includes('--apply');
  const json = process.argv.includes('--json');
  const trigger = (process.argv.find((a) => a.startsWith('--trigger='))?.split('=')[1] ?? 'manual').toLowerCase();
  if (!/^[a-z0-9_:-]{1,40}$/.test(trigger)) throw new Refusal('bad --trigger');

  const [have] = await runSql(`SELECT to_regprocedure('public.stock_v2_apply(text,boolean)') IS NOT NULL AS ok, public.stock_v2_enabled() AS enabled`)
    .catch(() => [{ ok: false }]);
  if (!have?.ok) { console.error('stock-run: stock_v2_apply() missing — apply 20260945000100…0500 first'); process.exit(2); }

  let r;
  if (!apply) {
    [{ r }] = await runSql(`SELECT public.stock_v2_apply('${trigger}', true) AS r`);
  } else {
    if (!have.enabled) { console.error('stock-run: stock_v2 is switched OFF — a real run would do nothing (switch it on first, owners only)'); process.exit(1); }
    [{ r }] = await runWrite(`SELECT public.stock_v2_apply('${trigger}', false) AS r`);
  }
  if (json) console.log(JSON.stringify(r, null, 2));
  else printStats(r);
  process.exit(r.status === 'ok' || (r.status === 'disabled' && !apply) ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((e) => { console.error(`stock-run: ${e?.message ?? e}`); process.exit(e instanceof Refusal ? 2 : 1); });
}
