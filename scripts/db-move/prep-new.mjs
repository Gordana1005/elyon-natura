#!/usr/bin/env node
/**
 * scripts/db-move/prep-new.mjs — prepare the NEW Macedonian project before the restore (03.10.2026).
 *
 *   node scripts/db-move/prep-new.mjs
 *
 * 1. Auth: signups OFF first (a fresh project accepts signups), then the source's auth settings copied
 *    through an allow-list (site URL, redirect allow-list, JWT expiry, rotation, MFA, password rules,
 *    rate limits). SMTP, hooks and provider secrets are never copied.
 * 2. Extensions the dump expects: pg_trgm IN SCHEMA PUBLIC (as on the source — the dumped indexes name
 *    "public"."gin_trgm_ops"), btree_gist / pgcrypto / uuid-ossp / pg_stat_statements / pg_net in
 *    `extensions`, pg_cron.
 * 3. PostgREST settings compared with the source (schemas, max rows, extra search path).
 *
 * Tokens: SUPABASE_ACCESS_TOKEN (source) and SUPABASE_ACCESS_TOKEN_NEW (target) from .env; never printed.
 * The target DB is reached as `postgres` through the session pooler with PGPASSFILE =
 * exports/db-move/<date>/pgpass.conf. The live Bulgarian project is refused by name.
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_REF = 'bmfxhgznttcnnlqloqzp';
const TARGET_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
const TARGET_HOST = 'aws-0-eu-central-1.pooler.supabase.com';
const PG = 'C:/Program Files/PostgreSQL/17/bin';
const date = process.argv[2] || '2026-10-03';
const PGPASS = join(ROOT, 'exports', 'db-move', date, 'pgpass.conf');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
if ([SOURCE_REF, TARGET_REF].includes(BG_REF)) die('refusing Bulgaria');

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const T = { old: env.SUPABASE_ACCESS_TOKEN, new: env.SUPABASE_ACCESS_TOKEN_NEW };
if (!T.old || !T.new) die('both SUPABASE_ACCESS_TOKEN and SUPABASE_ACCESS_TOKEN_NEW are needed in .env');

async function api(ref, token, path, init = {}) {
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, {
    ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${ref} ${path} → ${r.status} ${t.slice(0, 300)}`);
  try { return JSON.parse(t); } catch { return t; }
}
function psql(sql) {
  const r = spawnSync(`${PG}/psql.exe`, ['--dbname', `postgresql://postgres.${TARGET_REF}@${TARGET_HOST}:5432/postgres?sslmode=require`,
    '-X', '-At', '-w', '-v', 'ON_ERROR_STOP=1', '-c', sql],
  { encoding: 'utf8', env: { ...process.env, PGPASSFILE: PGPASS, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '30' } });
  if (r.status !== 0) die(`psql failed: ${(r.stderr || '').slice(0, 500)}`);
  return (r.stdout || '').trim();
}

// 1) auth — signups off first, then the allow-listed settings of the source
log('auth: signups off on the target …');
await api(TARGET_REF, T.new, '/config/auth', { method: 'PATCH', body: JSON.stringify({ disable_signup: true }) });
const src = await api(SOURCE_REF, T.old, '/config/auth');
const ALLOW = [
  'site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled', 'external_phone_enabled',
  'external_anonymous_users_enabled', 'mailer_autoconfirm', 'mailer_secure_email_change_enabled', 'mailer_otp_exp',
  'mailer_otp_length', 'jwt_exp', 'refresh_token_rotation_enabled', 'security_refresh_token_reuse_interval',
  'password_min_length', 'password_required_characters', 'password_hibp_enabled',
  'mfa_totp_enroll_enabled', 'mfa_totp_verify_enabled', 'mfa_max_enrolled_factors',
  'security_captcha_enabled', 'security_manual_linking_enabled',
  'sessions_single_per_user', 'sessions_timebox', 'sessions_inactivity_timeout',
  'rate_limit_anonymous_users', 'rate_limit_token_refresh',
  'rate_limit_verify', 'rate_limit_otp',
];
const patch = {};
for (const k of ALLOW) if (src[k] !== undefined && src[k] !== null) patch[k] = src[k];
patch.disable_signup = true;
await api(TARGET_REF, T.new, '/config/auth', { method: 'PATCH', body: JSON.stringify(patch) });
const dst = await api(TARGET_REF, T.new, '/config/auth');
const diff = ALLOW.filter((k) => JSON.stringify(src[k] ?? null) !== JSON.stringify(dst[k] ?? null));
log(`auth copied: ${Object.keys(patch).length} keys; differing after copy: ${diff.length ? diff.join(', ') : 'none'}`);
log(`auth target: site_url=${dst.site_url} signup_off=${dst.disable_signup} allow=${dst.uri_allow_list}`);

// 2) extensions on the target (as postgres through the session pooler)
log('extensions …');
psql(`create extension if not exists pg_trgm with schema public;
create extension if not exists btree_gist with schema extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists "uuid-ossp" with schema extensions;
create extension if not exists pg_stat_statements with schema extensions;
create extension if not exists pg_cron;
create extension if not exists pg_net with schema extensions;`);
log('extensions now: ' + psql(`select string_agg(e.extname||'@'||n.nspname, ', ' order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace`));

// 3) PostgREST compared
const [pOld, pNew] = await Promise.all([api(SOURCE_REF, T.old, '/postgrest'), api(TARGET_REF, T.new, '/postgrest')]);
for (const k of ['db_schema', 'max_rows', 'db_extra_search_path']) {
  const same = String(pOld[k]).replace(/\s/g, '') === String(pNew[k]).replace(/\s/g, '');
  log(`postgrest ${k}: ${same ? 'same' : `DIFFERS old=${pOld[k]} new=${pNew[k]}`}`);
}

// 4) state of the target
log('target state: ' + psql(`select 'pg='||current_setting('server_version')||' public_tables='||(select count(*) from pg_tables where schemaname='public')||' auth_users='||(select count(*) from auth.users)||' cron_jobs='||(select count(*) from cron.job)||' vault='||(select count(*) from vault.secrets)||' mig_schema='||(select exists(select 1 from pg_namespace where nspname='supabase_migrations'))||' pubs='||(select string_agg(pubname, ',') from pg_publication)||' bypassrls='||(select rolbypassrls from pg_roles where rolname='postgres')`));
log('DONE');
