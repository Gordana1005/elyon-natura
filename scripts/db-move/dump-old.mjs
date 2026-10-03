#!/usr/bin/env node
/**
 * scripts/db-move/dump-old.mjs — dump the SOURCE Macedonian project (read-only on the source) into
 * exports/db-move/<date>/ for the move to the new Supabase project (03.10.2026).
 *
 *   node scripts/db-move/dump-old.mjs [YYYY-MM-DD]
 *
 * Access: the Management API "cli/login-role" call — exactly what `supabase db dump --linked` does — hands
 * out a 5-minute password for cli_login_postgres (member of postgres). Every pg_dump then `SET ROLE postgres`
 * (--role postgres, BYPASSRLS), the same as the CLI's own dump script. Nothing is written on the source;
 * the password lives only in exports/db-move/<date>/pgpass.conf (gitignored) and expires by itself.
 *
 * Files: baseline-old.json · schema.sql (+ schema.sanitized.sql) · data.sql (COPY, public only — never cron/net/
 * vault) · auth-data.sql (auth.users + auth.identities: passwords and bans travel, sessions do not) ·
 * migrations.sql (supabase_migrations schema + rows) · timings.json. The source is always the ref below;
 * the live Bulgarian project is refused by name.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_REF = 'bmfxhgznttcnnlqloqzp';           // the project we copy FROM
const BG_REF = 'sxymaloycddnoxudxaqp';               // live Bulgaria — never
const HOST = 'aws-0-eu-west-1.pooler.supabase.com';  // session pooler of the source
const PG = 'C:/Program Files/PostgreSQL/17/bin';
const date = process.argv[2] || new Date().toISOString().slice(0, 10);
const OUT = join(ROOT, 'exports', 'db-move', date);
mkdirSync(OUT, { recursive: true });
const PGPASS = join(OUT, 'pgpass.conf');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };

if (SOURCE_REF === BG_REF) die('refusing Bulgaria');
const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
if (!toml.includes(`project_id = "${SOURCE_REF}"`)) die('config.toml does not point at the source ref');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const TOKEN = env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) die('SUPABASE_ACCESS_TOKEN missing in .env');

async function api(path, init = {}) {
  // A pg_dump can take 10+ minutes; the kept-alive socket to api.supabase.com may be dead by then → one retry.
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(`https://api.supabase.com/v1/projects/${SOURCE_REF}${path}`, {
        ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', Connection: 'close', ...(init.headers || {}) },
      });
      const t = await r.text();
      if (!r.ok) throw new Error(`${path} → ${r.status} ${t.slice(0, 300)}`);
      try { return JSON.parse(t); } catch { return t; }
    } catch (e) {
      if (attempt >= 3 || !/fetch failed|ECONNABORTED|ECONNRESET|EPIPE/.test(String(e?.cause || e))) throw e;
      log(`api ${path}: ${e.cause?.code || e.message} — retrying`);
      await new Promise((res) => setTimeout(res, 2000));
    }
  }
}
const USE_POSTGRES = process.argv.includes('--postgres');
const FROM = process.argv.includes('--from') ? process.argv[process.argv.indexOf('--from') + 1] : 'baseline';
const ORDER = ['baseline', 'schema', 'data', 'auth-data', 'migrations', 'finish'];
if (!ORDER.includes(FROM)) die(`--from must be one of ${ORDER.join(', ')}`);
const due = (step) => ORDER.indexOf(step) >= ORDER.indexOf(FROM);
const sqlRead = (query) => api('/database/query', { method: 'POST', body: JSON.stringify({ query, read_only: true }) });

/** 5-minute login as cli_login_postgres; written to pgpass (other hosts' lines kept). */
async function login() {
  const j = await api('/cli/login-role', { method: 'POST', body: JSON.stringify({ read_only: false }) });
  const user = `${j.role}.${SOURCE_REF}`;
  const keep = existsSync(PGPASS) ? readFileSync(PGPASS, 'utf8').split(/\r?\n/).filter((l) => l && !l.startsWith(`${HOST}:`)) : [];
  writeFileSync(PGPASS, [...keep, `${HOST}:5432:postgres:${user}:${j.password}`].join('\n') + '\n');
  return user;
}

const timings = {};
async function pgdump(label, args, file) {
  // --postgres: the postgres password is in pgpass (set through the API for the cutover) — the only way once the
  // source is frozen read-only, because the platform's cli/login-role needs a writable database.
  const user = USE_POSTGRES ? `postgres.${SOURCE_REF}` : await login();
  const t0 = Date.now();
  log(`${label} → ${file} …`);
  const r = spawnSync(`${PG}/pg_dump.exe`, [
    '--dbname', `postgresql://${user}@${HOST}:5432/postgres?sslmode=require`,
    '--role', 'postgres', '--quote-all-identifiers', '--no-owner', ...args, '--file', join(OUT, file),
  ], { stdio: 'inherit', env: { ...process.env, PGPASSFILE: PGPASS, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '30' } });
  if (r.status !== 0) die(`${label} failed (exit ${r.status})`);
  const sec = Math.round((Date.now() - t0) / 1000);
  const mb = (statSync(join(OUT, file)).size / 1048576).toFixed(1);
  timings[label] = { seconds: sec, mb: Number(mb) };
  log(`${label} done in ${sec}s, ${mb} MB`);
}

// 0) baseline (appendix C of exports/db-move/checklist-2026-10-02.md)
if (existsSync(join(OUT, 'timings.json'))) Object.assign(timings, JSON.parse(readFileSync(join(OUT, 'timings.json'), 'utf8')));
if (due('baseline')) {
log('baseline …');
const [base] = await sqlRead(`select json_build_object(
 'taken_at', now(),
 'orders',(select count(*) from public.orders), 'order_items',(select count(*) from public.order_items),
 'order_notes',(select count(*) from public.order_notes), 'customer_profiles',(select count(*) from public.customer_profiles),
 'mex_parcels',(select count(*) from public.mex_parcels), 'collabbox_documents',(select count(*) from public.collabbox_documents),
 'altercpa_leads',(select count(*) from public.altercpa_leads), 'web_orders',(select count(*) from public.web_orders),
 'prediction_segment_members',(select count(*) from public.prediction_segment_members), 'call_logs',(select count(*) from public.call_logs),
 'notifications',(select count(*) from public.notifications), 'shop_sales_lines',(select count(*) from public.shop_sales_lines),
 'order_history',(select count(*) from public.order_history), 'profiles',(select count(*) from public.profiles),
 'app_settings',(select count(*) from public.app_settings),
 'auth_users',(select count(*) from auth.users), 'auth_identities',(select count(*) from auth.identities),
 'auth_banned',(select count(*) from auth.users where banned_until > now()),
 'leaderboard_tokens',(select count(*) from public.leaderboard_access_tokens),
 'migrations',(select count(*) from supabase_migrations.schema_migrations), 'last_migration',(select max(version) from supabase_migrations.schema_migrations),
 'public_tables',(select count(*) from pg_tables where schemaname='public'),
 'public_functions',(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'),
 'triggers',(select count(*) from pg_trigger where not tgisinternal), 'policies',(select count(*) from pg_policies),
 'sequences',(select json_object_agg(sequencename, last_value) from pg_sequences where schemaname = 'public')
) as j`);
writeFileSync(join(OUT, 'baseline-old.json'), JSON.stringify(base.j, null, 1));
log(`baseline: orders=${base.j.orders} users=${base.j.auth_users} migrations=${base.j.migrations}`);
}

// 1) schema (public only; managed schemas, extensions and cron never travel)
if (due('schema')) await pgdump('schema', ['--schema-only', '--schema', 'public', '--no-publications', '--no-subscriptions', '--no-tablespaces', '--no-security-labels'], 'schema.sql');
// 2) data (COPY; public only)
if (due('data')) await pgdump('data', ['--data-only', '--schema', 'public'], 'data.sql');
// 3) auth users + identities (data only)
if (due('auth-data')) await pgdump('auth-data', ['--data-only', '--table', 'auth.users', '--table', 'auth.identities'], 'auth-data.sql');
// 4) CLI migration history
if (due('migrations')) await pgdump('migrations', ['--schema', 'supabase_migrations'], 'migrations.sql');

// 5) sanitize schema.sql the way the Supabase CLI's dump script does (comment platform-owned things, IF NOT EXISTS)
const raw = readFileSync(join(OUT, 'schema.sql'), 'utf8');
const sanitized = raw.split('\n').map((l) => {
  if (/^(COMMENT ON SCHEMA "public"|COMMENT ON EXTENSION |CREATE EVENT TRIGGER |ALTER EVENT TRIGGER |ALTER DEFAULT PRIVILEGES FOR ROLE "supabase_admin"|\\restrict|\\unrestrict)/.test(l)) return `-- ${l}`;
  return l.replace(/^CREATE SCHEMA "/, 'CREATE SCHEMA IF NOT EXISTS "');
}).join('\n');
writeFileSync(join(OUT, 'schema.sanitized.sql'), sanitized);
const mig = readFileSync(join(OUT, 'migrations.sql'), 'utf8')
  .replace(/^CREATE SCHEMA "/m, 'CREATE SCHEMA IF NOT EXISTS "').replace(/^CREATE TABLE "/mg, 'CREATE TABLE IF NOT EXISTS "');
writeFileSync(join(OUT, 'migrations.sanitized.sql'), mig);

// 6) sanity on the data file (1 GB — streamed, never read whole): never cron / net / vault / auth / storage in data.sql
const { createReadStream } = await import('node:fs');
const { createInterface } = await import('node:readline');
let copies = 0; const bad = [];
for await (const line of createInterface({ input: createReadStream(join(OUT, 'data.sql'), { encoding: 'utf8' }), crlfDelay: Infinity })) {
  if (line.startsWith('COPY "public".')) copies++;
  else if (/^COPY "(cron|net|vault|auth|storage)"\./.test(line)) bad.push(line.slice(0, 60));
}
const auth = readFileSync(join(OUT, 'auth-data.sql'), 'utf8');
const authCopies = (auth.match(/^COPY "auth"\."(users|identities)"/mg) || []).length;
timings.copies_public = copies; timings.auth_copies = authCopies; timings.forbidden_copies = bad.length;
writeFileSync(join(OUT, 'timings.json'), JSON.stringify(timings, null, 1));
log(`data.sql: ${copies} public COPY blocks, forbidden=${bad.length}; auth-data.sql: ${authCopies} COPY blocks`);
if (bad.length) die(`data.sql carries forbidden schemas: ${bad.slice(0, 3).join(', ')}`);
log('DONE');
