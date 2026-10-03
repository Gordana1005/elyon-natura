#!/usr/bin/env node
/**
 * scripts/db-move/deploy-functions.mjs — the NEW project's edge functions and their secrets (03.10.2026).
 *
 *   node scripts/db-move/deploy-functions.mjs [YYYY-MM-DD] [--only api,web-sync] [--secrets-only]
 *
 * 1. Secrets: the 15 names of exports/db-move/<date>/secrets.env (verified against the source's digests by
 *    collect-secrets.mjs) → POST /v1/projects/<NEW>/secrets. Values are never printed.
 * 2. Deploy the 6 functions from the repo with `supabase functions deploy <fn> --project-ref <NEW> --use-api`
 *    (server-side bundling; config.toml carries verify_jwt = false for every one, repeated as --no-verify-jwt).
 * 3. Proof: GET /functions → 6 slugs, all verify_jwt=false; GET /secrets → the 15 names present.
 *
 * Token: SUPABASE_ACCESS_TOKEN_NEW from .env (exported to the CLI as SUPABASE_ACCESS_TOKEN for the child
 * process only). The live Bulgarian project is refused by name.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
const FUNCTIONS = ['api', 'altercpa-sync', 'mex-reconcile', 'web-sync', 'collabbox-sync', 'collabbox-shops'];
const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-10-03';
const only = args.includes('--only') ? args[args.indexOf('--only') + 1].split(',') : FUNCTIONS;
const secretsOnly = args.includes('--secrets-only');
if (TARGET_REF === BG_REF) throw new Error('refusing Bulgaria');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
// before the cutover the new project's token is SUPABASE_ACCESS_TOKEN_NEW; after it, the main key
const TOKEN = env.SUPABASE_ACCESS_TOKEN_NEW || ((env.SUPABASE_URL || '').includes(TARGET_REF) ? env.SUPABASE_ACCESS_TOKEN : undefined);
if (!TOKEN) die('the access token of the new project is not in .env');
async function api(path, init = {}) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${TARGET_REF}${path}`, {
    ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 300)}`);
  try { return JSON.parse(t); } catch { return t; }
}

// 1) secrets
const secrets = readFileSync(join(ROOT, 'exports', 'db-move', date, 'secrets.env'), 'utf8').split(/\r?\n/)
  .filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return { name: l.slice(0, i), value: l.slice(i + 1) }; });
if (secrets.length !== 15) die(`expected 15 secrets in secrets.env, got ${secrets.length}`);
await api('/secrets', { method: 'POST', body: JSON.stringify(secrets) });
const names = (await api('/secrets')).map((s) => s.name);
const missing = secrets.map((s) => s.name).filter((n) => !names.includes(n));
log(`secrets set: ${secrets.length}; on the project now: ${names.length} names; missing: ${missing.join(', ') || 'none'}`);
if (missing.length) die('secrets missing after set');
if (secretsOnly) process.exit(0);

// 2) deploy
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
for (const fn of only) {
  if (!FUNCTIONS.includes(fn)) die(`unknown function ${fn}`);
  const t0 = Date.now();
  log(`deploy ${fn} …`);
  const r = spawnSync(npx, ['supabase', 'functions', 'deploy', fn, '--project-ref', TARGET_REF, '--no-verify-jwt', '--use-api'],
    { cwd: ROOT, stdio: 'inherit', shell: true, env: { ...process.env, SUPABASE_ACCESS_TOKEN: TOKEN } });
  if (r.status !== 0) die(`deploy ${fn} failed (exit ${r.status})`);
  log(`deploy ${fn} done in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// 3) proof
const fns = await api('/functions');
const bad = fns.filter((f) => f.verify_jwt !== false);
log(`functions on the project: ${fns.map((f) => `${f.slug}(v${f.version},${f.status})`).join(' ')}; verify_jwt≠false: ${bad.map((f) => f.slug).join(', ') || 'none'}`);
const absent = FUNCTIONS.filter((f) => !fns.some((x) => x.slug === f));
if (absent.length && only.length === FUNCTIONS.length) die(`not deployed: ${absent.join(', ')}`);
if (bad.length) die('a function verifies JWTs — cron callers would get 401');
log('DONE');
