#!/usr/bin/env node
/**
 * scripts/db-move/restore-new.mjs — restore the source dump into the NEW Macedonian project and finish it
 * (03.10.2026). Steps, each resumable with --from <step>:
 *
 *   precheck   the target is empty (public tables = 0), has the extensions, accepts replica mode
 *   schema     exports/db-move/<date>/schema.sanitized.sql, one transaction
 *   data       auth-data.sql + data.sql under session_replication_role = replica, ONE transaction
 *   history    migrations.sanitized.sql (supabase_migrations rows of the source)
 *   fixes      role timeouts, realtime publication (notifications), the auth.users trigger, the 5 vault rows
 *              (4 sync secrets from secrets.env + project_functions_base_url = this project's host)
 *   migration  supabase/migrations/20260948000100_project_move_function_urls.sql + its schema_migrations row
 *   cron       the 41 jobs of cron-old.json, scheduled and set INACTIVE in the same transaction
 *   check      counts / sequences / proofs against baseline-old.json → report.json
 *
 *   node scripts/db-move/restore-new.mjs [YYYY-MM-DD] [--from <step>]
 *
 * The target is reached as `postgres` through its session pooler (PGPASSFILE = exports/db-move/<date>/pgpass.conf).
 * The source project is never connected to. The live Bulgarian project is refused by name.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
const HOST = 'aws-0-eu-central-1.pooler.supabase.com';
const PG = 'C:/Program Files/PostgreSQL/17/bin';
const STEPS = ['precheck', 'schema', 'data', 'history', 'fixes', 'migration', 'cron', 'check'];
const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-10-03';
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : 'precheck';
if (!STEPS.includes(from)) throw new Error(`--from must be one of ${STEPS.join(', ')}`);
const OUT = join(ROOT, 'exports', 'db-move', date);
const PGPASS = join(OUT, 'pgpass.conf');
const MIGRATION = '20260948000100_project_move_function_urls.sql';
if (TARGET_REF === BG_REF) throw new Error('refusing Bulgaria');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const DSN = `postgresql://postgres.${TARGET_REF}@${HOST}:5432/postgres?sslmode=require`;
const PGENV = { ...process.env, PGPASSFILE: PGPASS, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '30', PGCLIENTENCODING: 'UTF8' };
const timings = existsSync(join(OUT, 'restore-timings.json')) ? JSON.parse(readFileSync(join(OUT, 'restore-timings.json'), 'utf8')) : {};
const saveTimings = () => writeFileSync(join(OUT, 'restore-timings.json'), JSON.stringify(timings, null, 1));

/** One psql call; `files` run in order inside ONE transaction when `single` is true. Streams output. */
function psqlRun(label, { pre = [], files = [], single = true }) {
  const a = ['--dbname', DSN, '-X', '-v', 'ON_ERROR_STOP=1', '-q'];
  if (single) a.push('--single-transaction');
  for (const c of pre) a.push('-c', c);
  for (const f of files) a.push('-f', f);
  const t0 = Date.now();
  log(`${label} …`);
  const r = spawnSync(`${PG}/psql.exe`, a, { stdio: 'inherit', env: PGENV });
  const sec = Math.round((Date.now() - t0) / 1000);
  timings[label] = { seconds: sec, ok: r.status === 0 };
  saveTimings();
  if (r.status !== 0) die(`${label} failed after ${sec}s (exit ${r.status})`);
  log(`${label} done in ${sec}s`);
}
/** One query, result as text (tuples only). */
function q(sql) {
  const r = spawnSync(`${PG}/psql.exe`, ['--dbname', DSN, '-X', '-q', '-At', '-w', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: PGENV });
  if (r.status !== 0) die(`query failed: ${(r.stderr || '').slice(0, 800)}\n${sql.slice(0, 200)}`);
  return (r.stdout || '').trim();
}
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const secretsEnv = () => Object.fromEntries(readFileSync(join(OUT, 'secrets.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));

const steps = {
  precheck() {
    const n = Number(q(`select count(*) from pg_tables where schemaname='public'`));
    if (n !== 0) die(`target already has ${n} public tables — this is a fresh-restore script`);
    const ext = q(`select string_agg(e.extname||'@'||n.nspname, ',' order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace`);
    for (const need of ['pg_trgm@public', 'btree_gist@extensions', 'pgcrypto@extensions', 'uuid-ossp@extensions', 'pg_cron@pg_catalog', 'pg_net@extensions', 'supabase_vault@vault'])
      if (!ext.includes(need)) die(`extension missing on target: ${need} (run prep-new.mjs)`);
    const rep = q(`set session_replication_role = replica; select current_setting('session_replication_role')`);
    if (rep !== 'replica') die('replica mode not allowed for postgres on the target');
    for (const f of ['schema.sanitized.sql', 'data.sql', 'auth-data.sql', 'migrations.sanitized.sql', 'secrets.env', 'cron-old.json', 'baseline-old.json'])
      if (!existsSync(join(OUT, f))) die(`missing ${f} in ${OUT}`);
    log(`precheck ok: empty target, extensions ${ext}, replica mode allowed`);
  },
  schema() {
    psqlRun('schema', { pre: ['set statement_timeout = 0', 'set lock_timeout = 0'], files: [join(OUT, 'schema.sanitized.sql')] });
    log(`public tables now ${q(`select count(*) from pg_tables where schemaname='public'`)}, functions ${q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'`)}`);
  },
  data() {
    psqlRun('data', {
      pre: ['set statement_timeout = 0', 'set lock_timeout = 0', 'set idle_in_transaction_session_timeout = 0', 'set session_replication_role = replica'],
      files: [join(OUT, 'auth-data.sql'), join(OUT, 'data.sql')],
    });
    log(`orders ${q('select count(*) from public.orders')}, auth.users ${q('select count(*) from auth.users')}`);
  },
  history() {
    psqlRun('history', { files: [join(OUT, 'migrations.sanitized.sql')] });
    log(`schema_migrations ${q('select count(*)||\' / \'||max(version) from supabase_migrations.schema_migrations')}`);
  },
  fixes() {
    // role timeouts (platform defaults may already match; a reserved-role refusal is reported, not fatal)
    const want = [['anon', 'statement_timeout', '3s'], ['authenticated', 'statement_timeout', '8s'], ['authenticator', 'statement_timeout', '8s'], ['authenticator', 'lock_timeout', '8s'], ['service_role', 'statement_timeout', '30s']];
    for (const [role, key, val] of want) {
      const cur = q(`select coalesce((select split_part(c, '=', 2) from pg_db_role_setting d join pg_roles r on r.oid=d.setrole, unnest(d.setconfig) c where r.rolname=${lit(role)} and c like ${lit(key + '=%')}), '')`);
      if (cur === val) { log(`role ${role} ${key} already ${val}`); continue; }
      const r = spawnSync(`${PG}/psql.exe`, ['--dbname', DSN, '-X', '-At', '-w', '-c', `alter role ${role} set ${key} = ${lit(val)}`], { encoding: 'utf8', env: PGENV });
      log(`role ${role} ${key} ${cur || '(unset)'} → ${val}: ${r.status === 0 ? 'ok' : 'REFUSED ' + (r.stderr || '').trim().slice(0, 120)}`);
    }
    q(`notify pgrst, 'reload config'`);
    // realtime publication + the auth trigger
    q(`do $$ begin if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='notifications') then alter publication supabase_realtime add table public.notifications; end if; end $$`);
    q(`do $$ begin if not exists (select 1 from pg_trigger where tgname='on_auth_user_created') then create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user(); end if; end $$`);
    log(`publication: ${q(`select string_agg(tablename, ',') from pg_publication_tables where pubname='supabase_realtime'`)}; auth trigger: ${q(`select count(*) from pg_trigger where tgname='on_auth_user_created'`)}`);
    // vault rows: the 4 sync secrets + the project's own functions host
    const s = secretsEnv();
    const rows = { altercpa_sync_secret: s.ALTERCPA_SYNC_SECRET, collabbox_sync_secret: s.COLLABBOX_SYNC_SECRET, mex_sync_secret: s.MEX_SYNC_SECRET, web_sync_secret: s.WEB_SYNC_SECRET, project_functions_base_url: `https://${TARGET_REF}.supabase.co` };
    for (const [name, value] of Object.entries(rows)) {
      if (!value) die(`secrets.env lacks the value for vault row ${name}`);
      q(`do $$ declare _id uuid; begin select id into _id from vault.secrets where name = ${lit(name)}; if _id is null then perform vault.create_secret(${lit(value)}, ${lit(name)}); else perform vault.update_secret(_id, ${lit(value)}); end if; end $$`);
    }
    log(`vault: ${q(`select string_agg(name||'='||(length(decrypted_secret)>0)::text, ', ' order by name) from vault.decrypted_secrets`)}`);
  },
  migration() {
    const file = join(ROOT, 'supabase', 'migrations', MIGRATION);
    const body = readFileSync(file, 'utf8');
    if (body.includes(BG_REF)) die('migration mentions Bulgaria');
    const [version, slug] = [MIGRATION.slice(0, 14), MIGRATION.slice(15, -4)];
    const applied = q(`select count(*) from supabase_migrations.schema_migrations where version = ${lit(version)}`);
    // Already in effect (the reader exists and no caller names the old host) → only the history row is missing.
    const inEffect = q(`select (exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='project_functions_base_url')
      and not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%bmfxhgznttcnnlqloqzp%'))::text`) === 'true';
    if (applied === '1') { log(`migration ${version} already recorded`); }
    else {
      if (inEffect) log(`migration ${version} already in effect — recording it`);
      else psqlRun('migration', { files: [file] });
      // The row goes in from a FILE: a Windows command line would re-encode the body's non-ASCII bytes.
      const rec = join(OUT, 'record-migration.sql');
      writeFileSync(rec, `insert into supabase_migrations.schema_migrations (version, name, statements) values (${lit(version)}, ${lit(slug)}, array[${lit(body)}]);\n`, 'utf8');
      psqlRun('migration-record', { files: [rec] });
    }
    const left = q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%bmfxhgznttcnnlqloqzp%'`);
    log(`functions still naming the old host: ${left}; base url: ${q('select public.project_functions_base_url()')}`);
    if (left !== '0') die('old host still present in a function body');
  },
  cron() {
    const jobs = JSON.parse(readFileSync(join(OUT, 'cron-old.json'), 'utf8'));
    const have = Number(q('select count(*) from cron.job'));
    if (have > 0) die(`target already has ${have} cron jobs — refusing to double-schedule`);
    const sql = jobs.map((j) => `select cron.schedule(${lit(j.jobname)}, ${lit(j.schedule)}, ${lit(j.command)});`).join('\n')
      + `\nselect cron.alter_job(jobid, active := false) from cron.job;\n`;
    writeFileSync(join(OUT, 'cron-new.sql'), sql);
    psqlRun('cron', { files: [join(OUT, 'cron-new.sql')] });
    const state = q(`select count(*)||' jobs, '||count(*) filter (where active)||' active' from cron.job`);
    log(`cron: ${state}`);
    if (!state.startsWith(`${jobs.length} jobs, 0 active`)) die('cron state unexpected');
  },
  check() {
    const base = JSON.parse(readFileSync(join(OUT, 'baseline-old.json'), 'utf8'));
    const now = JSON.parse(q(`select json_build_object(
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
)`));
    const report = { date, taken_at: new Date().toISOString(), rows: {}, sequences: {}, proofs: {}, ok: true };
    for (const k of Object.keys(base)) {
      if (['taken_at', 'sequences'].includes(k)) continue;
      const same = String(base[k]) === String(now[k]);
      const expected = k === 'migrations' ? Number(base[k]) + 1 : k === 'public_functions' ? Number(base[k]) + 1 : k === 'triggers' ? Number(base[k]) : base[k];
      const ok = String(expected) === String(now[k]) || same;
      report.rows[k] = { old: base[k], new: now[k], ok };
      if (!ok) report.ok = false;
      log(`${ok ? '✓' : '✗'} ${k.padEnd(28)} old=${base[k]} new=${now[k]}`);
    }
    for (const [name, v] of Object.entries(base.sequences || {})) {
      const nv = now.sequences?.[name];
      const ok = (v === null && nv === null) || (nv !== undefined && Number(nv) >= Number(v));
      report.sequences[name] = { old: v, new: nv, ok };
      if (!ok) { report.ok = false; log(`✗ sequence ${name} old=${v} new=${nv}`); }
    }
    const proofs = {
      old_host_in_functions: q(`select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%bmfxhgznttcnnlqloqzp%'`) === '0',
      base_url: q('select coalesce(public.project_functions_base_url(), \'\')') === `https://${TARGET_REF}.supabase.co`,
      cron_41_inactive: q(`select count(*)||'/'||count(*) filter (where active) from cron.job`) === '41/0',
      vault_5: q(`select count(*) from vault.decrypted_secrets where length(decrypted_secret) > 0`) === '5',
      publication_notifications: q(`select count(*) from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications'`) === '1',
      auth_trigger: q(`select count(*) from pg_trigger where tgname='on_auth_user_created'`) === '1',
      role_timeouts: q(`select string_agg(r.rolname||':'||c, ',' order by r.rolname, c) from pg_db_role_setting d join pg_roles r on r.oid=d.setrole, unnest(d.setconfig) c where r.rolname in ('anon','authenticated','authenticator','service_role') and c like '%timeout%'`),
      extensions: q(`select string_agg(e.extname||'@'||n.nspname, ',' order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace`),
      signup_disabled_checked_by: 'prep-new.mjs',
    };
    report.proofs = proofs;
    for (const [k, v] of Object.entries(proofs)) { if (v === false) report.ok = false; log(`${v === false ? '✗' : '✓'} ${k}: ${v}`); }
    writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 1));
    log(report.ok ? 'CHECK PASSED' : 'CHECK HAS FAILURES — see report.json');
    if (!report.ok) process.exitCode = 1;
  },
};

for (const s of STEPS.slice(STEPS.indexOf(from))) {
  log(`=== ${s}`);
  await steps[s]();
}
log('DONE');
