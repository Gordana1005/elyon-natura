#!/usr/bin/env node
/**
 * scripts/db-move/preflight.mjs — is the NEW project really ready? Every check reads both projects (read-only on
 * the old one) and prints PASS / FAIL / INFO; two small live proofs on the NEW project only:
 *   - the SQL path pg_cron would take: select public.invoke_web_sync('{}') → pg_net → the new host (its own secret);
 *   - the pg_cron scheduler: the harmless job `active-call-views-cleanup` is activated for ~75 s, must run once,
 *     and is deactivated again (0 active jobs afterwards — asserted).
 *
 *   node scripts/db-move/preflight.mjs [--no-live]
 *
 * Tokens from .env (SUPABASE_ACCESS_TOKEN = old, SUPABASE_ACCESS_TOKEN_NEW = new). Nothing secret is printed.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD_REF = 'bmfxhgznttcnnlqloqzp', NEW_REF = 'oufoazmnbwugtfldkwsn', BG_REF = 'sxymaloycddnoxudxaqp';
if ([OLD_REF, NEW_REF].includes(BG_REF)) throw new Error('refusing Bulgaria');
const LIVE = !process.argv.includes('--no-live');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
// both .env layouts: before the cutover plain = old and _NEW = new; after it _OLD = old and plain = new
const T = { OLD: [OLD_REF, env.SUPABASE_ACCESS_TOKEN_OLD || env.SUPABASE_ACCESS_TOKEN], NEW: [NEW_REF, env.SUPABASE_ACCESS_TOKEN_NEW || env.SUPABASE_ACCESS_TOKEN] };
async function api(which, path, init = {}) {
  const [ref, token] = T[which];
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const t = await r.text();
  if (!r.ok) return { __status: r.status, __body: t.slice(0, 200) };
  try { return JSON.parse(t); } catch { return t; }
}
async function sql(which, query, ro = true) {
  if (which === 'OLD' && !ro) throw new Error('never write to the old project');
  const r = await api(which, '/database/query', { method: 'POST', body: JSON.stringify(ro ? { query, read_only: true } : { query }) });
  if (r && r.__status) throw new Error(`${which} sql ${r.__status} ${r.__body}`);
  return r;
}
const results = [];
const out = (status, name, detail = '') => { results.push({ status, name, detail }); console.log(`${status.padEnd(4)} ${name}${detail ? ' — ' + detail : ''}`); };
const same = (name, a, b, show = (v) => JSON.stringify(v)) => out(JSON.stringify(a) === JSON.stringify(b) ? 'PASS' : 'FAIL', name, `old ${show(a)} · new ${show(b)}`);
const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1) compute, backups, disk, limits
const [aO, aN] = await Promise.all([api('OLD', '/billing/addons'), api('NEW', '/billing/addons')]);
const compute = (a) => { const c = (a?.selected_addons || []).find((x) => x.type === 'compute_instance'); return c ? (c.variant?.identifier || c.variant?.name || JSON.stringify(c.variant || c)) : 'nano/micro (none)'; };
same('compute add-on', compute(aO), compute(aN), String);
const [bO, bN] = await Promise.all([api('OLD', '/database/backups'), api('NEW', '/database/backups')]);
same('backups: PITR flag', !!bO.pitr_enabled, !!bN.pitr_enabled);
out(bN.backups?.length ? 'PASS' : 'FAIL', 'backups on the new project', `${bN.backups?.length ?? 0} daily backups kept`);
const lim = `select current_setting('max_connections') mc, current_setting('shared_buffers') sb, current_setting('work_mem') wm, pg_size_pretty(pg_database_size('postgres')) size, (select count(*) from pg_stat_activity) conns, (select round(100.0*sum(blks_hit)/nullif(sum(blks_hit+blks_read),0),1) from pg_stat_database where datname='postgres') cache_hit, current_setting('server_version') v`;
const [[lO], [lN]] = await Promise.all([sql('OLD', lim), sql('NEW', lim)]);
same('max_connections / shared_buffers / work_mem', [lO.mc, lO.sb, lO.wm], [lN.mc, lN.sb, lN.wm]);
out('INFO', 'database size / connections in use / cache hit', `old ${lO.size}, ${lO.conns} conns, hit ${lO.cache_hit}% · new ${lN.size}, ${lN.conns} conns, hit ${lN.cache_hit}% · pg ${lO.v} → ${lN.v}`);

// 2) secrets: every custom name of the old project exists on the new with the SAME digest
const [sO, sN] = await Promise.all([api('OLD', '/secrets'), api('NEW', '/secrets')]);
const dO = Object.fromEntries(sO.map((s) => [s.name, s.value])), dN = Object.fromEntries(sN.map((s) => [s.name, s.value]));
const custom = Object.keys(dO).filter((n) => !n.startsWith('SUPABASE_'));
const bad = custom.filter((n) => dN[n] !== dO[n]);
out(bad.length ? 'FAIL' : 'PASS', `function secrets equal by digest`, `${custom.length} custom names${bad.length ? '; differ/missing: ' + bad.join(', ') : ''}`);
const auto = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_DB_URL', 'SUPABASE_JWKS', 'SUPABASE_PUBLISHABLE_KEYS', 'SUPABASE_SECRET_KEYS'];
const autoMissing = auto.filter((n) => !dN[n]);
out(autoMissing.length ? 'FAIL' : 'PASS', 'platform secrets injected into the functions', autoMissing.length ? 'missing: ' + autoMissing.join(', ') : auto.length + ' present');

// 3) vault rows on the new project = the function secrets (sha256 of the decrypted value vs the digest)
const vault = await sql('NEW', `select name, encode(sha256(convert_to(decrypted_secret, 'UTF8')), 'hex') h, decrypted_secret = 'https://${NEW_REF}.supabase.co' as is_base from vault.decrypted_secrets order by name`, false); // as postgres: the read-only role may not decrypt
const pairs = { altercpa_sync_secret: 'ALTERCPA_SYNC_SECRET', collabbox_sync_secret: 'COLLABBOX_SYNC_SECRET', mex_sync_secret: 'MEX_SYNC_SECRET', web_sync_secret: 'WEB_SYNC_SECRET' };
const vaultBad = Object.entries(pairs).filter(([v, s]) => vault.find((r) => r.name === v)?.h !== dN[s]).map(([v]) => v);
out(vaultBad.length ? 'FAIL' : 'PASS', 'vault sync secrets = function secrets', vaultBad.length ? 'mismatch: ' + vaultBad.join(', ') : '4 pairs equal');
out(vault.find((r) => r.name === 'project_functions_base_url')?.is_base ? 'PASS' : 'FAIL', 'vault project_functions_base_url', `https://${NEW_REF}.supabase.co`);

// 4) the keys the SPA / scripts will use
const anon = env.VITE_SUPABASE_PUBLISHABLE_KEY_NEW || env.VITE_SUPABASE_PUBLISHABLE_KEY, svc = env.SUPABASE_SERVICE_ROLE_KEY_NEW || env.SUPABASE_SERVICE_ROLE_KEY, url = env.SUPABASE_URL_NEW || env.SUPABASE_URL;
const claim = (jwt) => { try { return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString()); } catch { return {}; } };
out(claim(anon).ref === NEW_REF && claim(anon).role === 'anon' ? 'PASS' : 'FAIL', '.env VITE_SUPABASE_PUBLISHABLE_KEY_NEW', `ref ${claim(anon).ref}, role ${claim(anon).role}, exp ${new Date((claim(anon).exp || 0) * 1000).toISOString().slice(0, 10)}`);
out(claim(svc).ref === NEW_REF && claim(svc).role === 'service_role' ? 'PASS' : 'FAIL', '.env SUPABASE_SERVICE_ROLE_KEY_NEW', `ref ${claim(svc).ref}, role ${claim(svc).role}`);
const rest = async (key) => { const r = await fetch(`${url}/rest/v1/app_settings?select=key&limit=1`, { headers: { apikey: key, Authorization: `Bearer ${key}` } }); return [r.status, (await r.text()).slice(0, 80)]; };
const [rs, rsBody] = await rest(svc); out(rs === 200 ? 'PASS' : 'FAIL', 'PostgREST with the service role (new)', `${rs} ${rsBody}`);
const [ra, raBody] = await rest(anon); out(ra === 200 || ra === 401 || ra === 403 ? 'PASS' : 'FAIL', 'PostgREST with anon (new; RLS decides)', `${ra} ${raBody}`);
const health = await fetch(`${url}/auth/v1/health`, { headers: { apikey: anon } }); out(health.ok ? 'PASS' : 'FAIL', 'Auth health (new)', `${health.status}`);
const rt = await fetch(`${url}/realtime/v1/api/tenants/${NEW_REF}/health`, { headers: { apikey: anon } }).catch(() => null);
out(rt && rt.ok ? 'PASS' : 'INFO', 'Realtime health (new)', rt ? `${rt.status} ${(await rt.text()).slice(0, 80)}` : 'no answer');

// 5) functions, auth config, PostgREST, network, SSL
const [fO, fN] = await Promise.all([api('OLD', '/functions'), api('NEW', '/functions')]);
const slugs = (f) => f.map((x) => `${x.slug}:${x.verify_jwt}:${x.status}`).sort();
same('edge functions (slug:verify_jwt:status)', slugs(fO), slugs(fN), (v) => v.length + ' fns');
out('INFO', 'function versions', `old ${fO.map((x) => x.slug + ' v' + x.version).join(', ')} · new ${fN.map((x) => x.slug + ' v' + x.version).join(', ')}`);
const [cO, cN] = await Promise.all([api('OLD', '/config/auth'), api('NEW', '/config/auth')]);
const AUTH_KEYS = ['site_url', 'uri_allow_list', 'disable_signup', 'external_email_enabled', 'mailer_autoconfirm', 'jwt_exp', 'refresh_token_rotation_enabled', 'security_refresh_token_reuse_interval', 'password_min_length', 'mfa_totp_enroll_enabled', 'mfa_totp_verify_enabled', 'security_captcha_enabled', 'sessions_single_per_user', 'smtp_host', 'hook_custom_access_token_enabled'];
const authDiff = AUTH_KEYS.filter((k) => JSON.stringify(cO[k] ?? null) !== JSON.stringify(cN[k] ?? null));
out(authDiff.length ? 'FAIL' : 'PASS', 'auth settings equal', authDiff.length ? 'differ: ' + authDiff.join(', ') : AUTH_KEYS.length + ' keys');
const [pO, pN] = await Promise.all([api('OLD', '/postgrest'), api('NEW', '/postgrest')]);
same('PostgREST schemas / max_rows / search_path', [pO.db_schema?.replace(/\s/g, ''), pO.max_rows, pO.db_extra_search_path?.replace(/\s/g, '')], [pN.db_schema?.replace(/\s/g, ''), pN.max_rows, pN.db_extra_search_path?.replace(/\s/g, '')]);
const [nO, nN] = await Promise.all([api('OLD', '/network-restrictions'), api('NEW', '/network-restrictions')]);
same('network restrictions', nO.config?.dbAllowedCidrs, nN.config?.dbAllowedCidrs);
const [eO, eN] = await Promise.all([api('OLD', '/ssl-enforcement'), api('NEW', '/ssl-enforcement')]);
same('SSL enforcement', eO.currentConfig?.database, eN.currentConfig?.database);
const keysN = await api('NEW', '/api-keys?reveal=false');
out(Array.isArray(keysN) && keysN.some((k) => k.name === 'anon' && k.type === 'legacy') && keysN.some((k) => k.name === 'service_role' && k.type === 'legacy') ? 'PASS' : 'FAIL', 'legacy anon + service_role keys exist (new)', Array.isArray(keysN) ? keysN.map((k) => `${k.name}/${k.type}`).join(', ') : '?');

// 6) database state: schema parity, settings rows, cron, publication, trigger, extensions, no old host
const state = `select (select count(*) from pg_tables where schemaname='public') tables,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') fns,
 (select count(*) from pg_policies) policies, (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where not t.tgisinternal and n.nspname='public') pub_triggers,
 (select count(*) from pg_indexes where schemaname='public') indexes,
 (select string_agg(e.extname||'@'||n.nspname, ',' order by e.extname) from pg_extension e join pg_namespace n on n.oid=e.extnamespace) ext,
 (select string_agg(tablename, ',') from pg_publication_tables where pubname='supabase_realtime') pub,
 (select count(*) from pg_trigger where tgname='on_auth_user_created') auth_trg,
 (select count(*) from supabase_migrations.schema_migrations) migrations,
 (select max(version) from supabase_migrations.schema_migrations) last_migration,
 (select count(*) from cron.job) cron_total, (select count(*) from cron.job where active) cron_active,
 (select string_agg(distinct username||'/'||database||'/'||nodename, ',') from cron.job) cron_identity,
 (select count(*) from auth.users) users, (select count(*) from auth.users where banned_until > now()) banned,
 (select jsonb_object_agg(key, value) from public.app_settings where key in ('mex_push','shops_reader','collab_entry_rule','no_parcel_rule','link_lead_parcels','leads_parcel_orders','stock_v2','sale_day_revive','late_sale_new_order')) switches,
 (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosrc like '%${OLD_REF}%') old_host_fns`;
const [[xO], [xN]] = await Promise.all([sql('OLD', state), sql('NEW', state)]);
// the new project carries two extra functions by design: project_functions_base_url() (the move) and rls_auto_enable() (platform)
same('public tables / functions / policies / public triggers / indexes', [xO.tables, xO.fns, xO.policies, xO.pub_triggers, xO.indexes], [xN.tables, xN.fns - 2, xN.policies, xN.pub_triggers, xN.indexes], (v) => v.join('/'));
out(Number(xN.migrations) === Number(xO.migrations) + 1 ? 'PASS' : 'FAIL', 'migrations = old + the move migration', `old ${xO.migrations} (${xO.last_migration}) · new ${xN.migrations} (${xN.last_migration})`);
same('extensions', xO.ext, xN.ext, (v) => v.split(',').length + ' ext');
same('realtime publication tables', xO.pub, xN.pub, String);
same('auth.users trigger', xO.auth_trg, xN.auth_trg, String);
same('auth users / banned', [xO.users, xO.banned], [xN.users, xN.banned]);
out(Number(xN.cron_total) === Number(xO.cron_total) && Number(xN.cron_active) === 0 ? 'PASS' : 'FAIL', 'cron jobs present and INACTIVE on the new project', `old ${xO.cron_total}/${xO.cron_active} active · new ${xN.cron_total}/${xN.cron_active} active · identity ${xN.cron_identity}`);
same('app_settings switches (mex_push, shops_reader, collab_entry_rule, …)', xO.switches, xN.switches, (v) => Object.keys(v || {}).length + ' keys');
out(Number(xN.old_host_fns) === 0 ? 'PASS' : 'FAIL', 'no function names the old host (new)', `${xN.old_host_fns}`);
const [[base]] = [await sql('NEW', 'select public.project_functions_base_url() b', false)]; // service_role-only: run as postgres
out(base.b === `https://${NEW_REF}.supabase.co` ? 'PASS' : 'FAIL', 'project_functions_base_url()', base.b);
const runs = await sql('NEW', `(select 'web' src, status::text, started_at::text from public.web_sync_runs order by started_at desc limit 1)
 union all (select 'mex', status::text, started_at::text from public.mex_sync_runs order by started_at desc limit 1)
 union all (select 'altercpa', status::text, started_at::text from public.altercpa_sync_runs order by started_at desc limit 1)
 union all (select 'collabbox', status::text, started_at::text from public.collabbox_sync_runs order by started_at desc limit 1)
 union all (select 'shops', status::text, started_at::text from public.shops_reader_runs order by started_at desc limit 1)`).catch((e) => [{ src: 'runs', status: 'query failed: ' + e.message.slice(0, 80), started_at: '' }]);
out('INFO', 'last sync runs on the new project', runs.map((r) => `${r.src}=${r.status} ${String(r.started_at).slice(0, 16)}`).join(' · '));

// 7) live proofs on the NEW project only
if (LIVE) {
  // a) the SQL path: invoke_web_sync → pg_net → the new host with the vault secret
  const before = (await sql('NEW', 'select coalesce(max(id),0) m from net._http_response'))[0].m;
  await sql('NEW', "select public.invoke_web_sync('{}'::jsonb)", false);
  let resp = null;
  for (let i = 0; i < 12 && !resp; i++) { await sleep(5000); const r = await sql('NEW', `select status_code, left(coalesce(error_msg,''),80) err from net._http_response where id > ${before} order by id desc limit 1`); if (r.length) resp = r[0]; }
  out(resp && resp.status_code === 200 ? 'PASS' : 'FAIL', 'SQL invoke_web_sync() → pg_net → new host', resp ? `HTTP ${resp.status_code} ${resp.err}` : 'no response row within 60 s');
  // b) the scheduler: a harmless job for ~75 s
  const job = 'active-call-views-cleanup';
  const runsBefore = (await sql('NEW', `select count(*) n from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='${job}'`))[0].n;
  await sql('NEW', `select cron.alter_job(jobid, active := true) from cron.job where jobname = '${job}'`, false);
  await sleep(75000);
  await sql('NEW', `select cron.alter_job(jobid, active := false) from cron.job where jobname = '${job}'`, false);
  const [{ n: runsAfter, st }] = await sql('NEW', `select count(*) n, string_agg(d.status, ',') st from cron.job_run_details d join cron.job j on j.jobid=d.jobid where j.jobname='${job}'`);
  const [{ a }] = await sql('NEW', 'select count(*) a from cron.job where active');
  out(Number(runsAfter) > Number(runsBefore) && /succeeded/.test(st || '') && Number(a) === 0 ? 'PASS' : 'FAIL', 'pg_cron scheduler runs a job on the new project (then 0 active again)', `runs ${runsBefore} → ${runsAfter} (${st || '-'}), active jobs now ${a}`);
}

const fails = results.filter((r) => r.status === 'FAIL');
console.log(`\n${fails.length ? 'FAIL' : 'PASS'} — ${results.filter((r) => r.status === 'PASS').length} pass, ${fails.length} fail, ${results.filter((r) => r.status === 'INFO').length} info`);
process.exit(fails.length ? 1 : 0);
