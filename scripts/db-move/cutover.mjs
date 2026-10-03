#!/usr/bin/env node
/**
 * scripts/db-move/cutover.mjs — the cutover night, one subcommand per step (03.10.2026). Run in this order:
 *
 *   parity        OLD vs NEW schema: every public function body, column, index, trigger and policy by md5; the
 *                 migration versions. Read-only. Must be clean before the freeze.
 *   freeze        OLD: save the cron state, switch every cron job off, wait for pg_net and running syncs to drain,
 *                 `default_transaction_read_only = on`, terminate client connections. (Logins and session refresh
 *                 stop; SQL writes fail. Rehearsed on the new project.)
 *   writes-since <ISO time>   OLD: anything written after that moment? (orders / notes / history / leads)
 *   unfreeze      OLD: read-write again + the saved cron state restored (the rollback).
 *   vercel-env    Vercel Production env → the NEW project (URL, publishable key, project id), verified by reading back.
 *   vercel-env-old   the same three back to the OLD project (the rollback).
 *   vercel-wait <sha>   wait until the production deployment of that commit is READY, then prove the live bundle
 *                 names the NEW host and not the old one.
 *   cron-on       NEW: all jobs active (refuses while any job is active on OLD).
 *   cron-off      NEW: all jobs inactive (the rollback).
 *
 * Tokens: .env SUPABASE_ACCESS_TOKEN (old) / SUPABASE_ACCESS_TOKEN_NEW or, after the .env switch,
 * SUPABASE_ACCESS_TOKEN_OLD (old) / SUPABASE_ACCESS_TOKEN (new) — both layouts are understood. The Vercel token is
 * read from D:\naturatherapy\vault.md line 60. Nothing secret is printed. Bulgaria is refused by name.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD_REF = 'bmfxhgznttcnnlqloqzp', NEW_REF = 'oufoazmnbwugtfldkwsn', BG_REF = 'sxymaloycddnoxudxaqp';
if ([OLD_REF, NEW_REF].includes(BG_REF)) throw new Error('refusing Bulgaria');
const STATE_DIR = join(ROOT, 'exports', 'db-move', 'cutover');
const VERCEL = { project: 'prj_cwxmm4jb74hUHmAb6YzbUG7PuDy3', team: 'team_fT756uoO13MD9jtimyq27JNy' };
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
// before the .env switch: plain = old, _NEW = new; after it: _OLD = old, plain = new
const switched = (env.SUPABASE_URL || '').includes(NEW_REF);
const TOKENS = switched
  ? { OLD: env.SUPABASE_ACCESS_TOKEN_OLD, NEW: env.SUPABASE_ACCESS_TOKEN }
  : { OLD: env.SUPABASE_ACCESS_TOKEN, NEW: env.SUPABASE_ACCESS_TOKEN_NEW };
const NEW_KEYS = switched
  ? { url: env.VITE_SUPABASE_URL, anon: env.VITE_SUPABASE_PUBLISHABLE_KEY }
  : { url: env.VITE_SUPABASE_URL_NEW, anon: env.VITE_SUPABASE_PUBLISHABLE_KEY_NEW };
const OLD_KEYS = switched
  ? { url: env.VITE_SUPABASE_URL_OLD, anon: env.VITE_SUPABASE_PUBLISHABLE_KEY_OLD }
  : { url: env.VITE_SUPABASE_URL, anon: env.VITE_SUPABASE_PUBLISHABLE_KEY };
const REFS = { OLD: OLD_REF, NEW: NEW_REF };

async function sql(which, query, { ro = true } = {}) {
  if (!TOKENS[which]) die(`no access token for ${which} in .env`);
  const r = await fetch(`https://api.supabase.com/v1/projects/${REFS[which]}/database/query`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKENS[which]}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(ro ? { query, read_only: true } : { query }),
  });
  const t = await r.text();
  if (!r.ok) throw new Error(`${which} sql ${r.status}: ${t.slice(0, 500)}`);
  try { return JSON.parse(t); } catch { return []; }
}
const TERMINATE = `select count(pg_terminate_backend(pid)) n from pg_stat_activity where datname = 'postgres' and pid <> pg_backend_pid() and backend_type = 'client backend' and usename in ('authenticator', 'postgres', 'supabase_auth_admin', 'supabase_storage_admin')`;

const steps = {
  async parity() {
    const Q = {
      functions: `select p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' k, md5(replace(p.prosrc, chr(13), '')) h from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`,
      columns: `select table_name || '.' || column_name k, md5(data_type || '|' || coalesce(udt_name, '') || '|' || is_nullable || '|' || coalesce(column_default, '')) h from information_schema.columns where table_schema = 'public'`,
      indexes: `select indexname k, md5(indexdef) h from pg_indexes where schemaname = 'public'`,
      triggers: `select c.relname || '.' || t.tgname k, md5(pg_get_triggerdef(t.oid)) h from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname = 'public'`,
      policies: `select tablename || '.' || policyname k, md5(coalesce(qual, '') || '|' || coalesce(with_check, '') || '|' || cmd || '|' || array_to_string(roles, ',')) h from pg_policies where schemaname = 'public'`,
      constraints: `select conrelid::regclass::text || '.' || conname k, md5(pg_get_constraintdef(oid)) h from pg_constraint where connamespace = 'public'::regnamespace`,
      migrations: `select version k, '1' h from supabase_migrations.schema_migrations`,
      settings: `select key k, md5(value::text) h from public.app_settings`,
    };
    const EXPECTED_NEW_ONLY = new Set(['project_functions_base_url()', 'rls_auto_enable()', '20260948000100']);
    const MOVED = /^invoke_(affiliate_postback_drain|altercpa_sync|collabbox_shops|collabbox_sync|mex_reconcile|mex_reconcile_sweep|web_sync)\(/;
    let bad = 0;
    for (const [name, query] of Object.entries(Q)) {
      const [o, n] = await Promise.all([sql('OLD', query), sql('NEW', query)]);
      const O = new Map(o.map((r) => [r.k, r.h])), N = new Map(n.map((r) => [r.k, r.h]));
      const onlyOld = [...O.keys()].filter((k) => !N.has(k));
      const onlyNew = [...N.keys()].filter((k) => !O.has(k) && !EXPECTED_NEW_ONLY.has(k));
      const differ = [...O.keys()].filter((k) => N.has(k) && N.get(k) !== O.get(k) && !(name === 'functions' && MOVED.test(k)));
      const ok = !onlyOld.length && !onlyNew.length && !differ.length;
      if (!ok && name !== 'settings') bad++;
      log(`${ok ? '✓' : name === 'settings' ? '·' : '✗'} ${name.padEnd(11)} old ${O.size} · new ${N.size}${onlyOld.length ? ` · only OLD: ${onlyOld.slice(0, 8).join(', ')}${onlyOld.length > 8 ? ' …' : ''}` : ''}${onlyNew.length ? ` · only NEW: ${onlyNew.slice(0, 8).join(', ')}` : ''}${differ.length ? ` · differ: ${differ.slice(0, 8).join(', ')}${differ.length > 8 ? ` … (${differ.length})` : ''}` : ''}`);
    }
    log(bad ? `PARITY: ${bad} group(s) differ — fix before the freeze` : 'PARITY OK (settings rows are data and travel with the load)');
    if (bad) process.exitCode = 1;
  },

  async freeze() {
    if (!existsSync(STATE_DIR)) (await import('node:fs')).mkdirSync(STATE_DIR, { recursive: true });
    const jobs = await sql('OLD', 'select jobid, jobname, schedule, active from cron.job order by jobid');
    const stateFile = join(STATE_DIR, 'old-cron-state.json');
    if (!existsSync(stateFile)) writeFileSync(stateFile, JSON.stringify({ saved_at: new Date().toISOString(), jobs }, null, 1));
    log(`cron state saved (${jobs.length} jobs, ${jobs.filter((j) => j.active).length} active) → ${stateFile}`);
    await sql('OLD', 'select cron.alter_job(jobid, active := false) from cron.job', { ro: false });
    log('cron: all jobs inactive on OLD');
    for (let i = 0; i < 40; i++) {
      const [s] = await sql('OLD', `select (select count(*) from net.http_request_queue) q,
        (select count(*) from pg_stat_activity where datname='postgres' and state <> 'idle' and pid <> pg_backend_pid() and backend_type = 'client backend') active,
        (select count(*) from cron.job_run_details where status = 'running') cron_running`);
      log(`drain: pg_net queue ${s.q}, active client queries ${s.active}, cron runs running ${s.cron_running}`);
      if (Number(s.q) === 0 && Number(s.active) === 0 && Number(s.cron_running) === 0) break;
      await sleep(10000);
    }
    // edge functions started by the last pg_net calls may still be writing: give them their time
    for (let i = 0; i < 30; i++) {
      const r = await sql('OLD', `(select 'web' s, count(*) n from web_sync_runs where status::text='running') union all (select 'mex', count(*) from mex_sync_runs where status::text='running') union all (select 'altercpa', count(*) from altercpa_sync_runs where status::text='running') union all (select 'collabbox', count(*) from collabbox_sync_runs where status::text='running') union all (select 'shops', count(*) from shops_reader_runs where status::text='running')`);
      const running = r.filter((x) => Number(x.n) > 0);
      if (!running.length) { log('no sync run is running'); break; }
      log(`still running: ${running.map((x) => `${x.s}=${x.n}`).join(', ')}`);
      await sleep(10000);
    }
    await sql('OLD', 'alter database postgres set default_transaction_read_only = on', { ro: false });
    const [t] = await sql('OLD', TERMINATE, { ro: false }).catch(() => [{ n: '?' }]);
    await sleep(4000);
    const frozenAt = new Date().toISOString();
    writeFileSync(join(STATE_DIR, 'frozen-at.txt'), frozenAt);
    const probe = await sql('OLD', `create temp table __probe(i int)`, { ro: false }).then(() => 'WRITE STILL POSSIBLE', (e) => /read-only/.test(e.message) ? 'writes refused' : e.message.slice(0, 80));
    log(`OLD is read-only (${probe}); ${t.n} client connections terminated; frozen at ${frozenAt}`);
    if (probe !== 'writes refused') die('the freeze did not take');
  },

  async 'writes-since'() {
    const since = process.argv[3] || (existsSync(join(STATE_DIR, 'frozen-at.txt')) ? readFileSync(join(STATE_DIR, 'frozen-at.txt'), 'utf8').trim() : null);
    if (!since) die('usage: cutover.mjs writes-since <ISO time>');
    const [r] = await sql('OLD', `select
      (select count(*) from orders where updated_at > '${since}' or created_at > '${since}') orders,
      (select count(*) from order_notes where created_at > '${since}') notes,
      (select count(*) from order_history where changed_at > '${since}') history,
      (select count(*) from call_logs where created_at > '${since}') calls,
      (select count(*) from notifications where created_at > '${since}') notifications,
      (select count(*) from altercpa_leads where last_seen_at > '${since}') leads,
      (select count(*) from mex_parcels where last_seen_at > '${since}') parcels`);
    const total = Object.values(r).reduce((a, b) => a + Number(b), 0);
    log(`OLD writes after ${since}: ${JSON.stringify(r)}`);
    log(total ? '✗ something was written on OLD after that moment' : '✓ nothing was written on OLD after that moment');
    if (total) process.exitCode = 1;
  },

  async unfreeze() {
    await sql('OLD', 'begin read write; alter database postgres reset default_transaction_read_only; commit;', { ro: false });
    await sql('OLD', `begin read write; ${TERMINATE}; commit;`, { ro: false }).catch(() => {});
    await sleep(4000);
    const state = JSON.parse(readFileSync(join(STATE_DIR, 'old-cron-state.json'), 'utf8'));
    const newActive = Number((await sql('NEW', 'select count(*) n from cron.job where active'))[0].n);
    if (newActive > 0) die(`NEW still has ${newActive} active cron jobs — run cron-off first (never both)`);
    const ids = state.jobs.filter((j) => j.active).map((j) => j.jobid);
    await sql('OLD', `select cron.alter_job(jobid, active := true) from cron.job where jobid in (${ids.join(',')})`, { ro: false });
    const [c] = await sql('OLD', 'select count(*) total, count(*) filter (where active) active from cron.job');
    log(`OLD is read-write again; cron ${c.active}/${c.total} active`);
  },

  async 'vercel-env'() { await vercelEnv(NEW_KEYS, NEW_REF); },
  async 'vercel-env-old'() { await vercelEnv(OLD_KEYS, OLD_REF); },

  async 'vercel-wait'() {
    const sha = process.argv[3];
    if (!sha) die('usage: cutover.mjs vercel-wait <commit sha>');
    const tok = vercelToken();
    let ready = null;
    for (let i = 0; i < 60 && !ready; i++) {
      const r = await fetch(`https://api.vercel.com/v6/deployments?projectId=${VERCEL.project}&teamId=${VERCEL.team}&limit=5&target=production`, { headers: { Authorization: `Bearer ${tok}` } });
      const d = ((await r.json()).deployments || []).find((x) => (x.meta?.githubCommitSha || '').startsWith(sha));
      log(d ? `deployment ${d.uid} ${d.state}` : 'deployment not created yet');
      if (d?.state === 'READY') ready = d;
      else if (d?.state === 'ERROR' || d?.state === 'CANCELED') die(`deployment ${d.state}`);
      else await sleep(10000);
    }
    if (!ready) die('deployment not READY in 10 minutes');
    // the live bundle must name the NEW host
    const html = await (await fetch(`https://naturall.mk/?t=${Date.now()}`, { headers: { 'Cache-Control': 'no-cache' } })).text();
    const assets = [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+\.js)"/g)].map((m) => m[1]);
    let hasNew = false, hasOld = false;
    for (const a of assets) {
      const js = await (await fetch(`https://naturall.mk${a}`)).text();
      if (js.includes(NEW_REF)) hasNew = true;
      if (js.includes(OLD_REF)) hasOld = true;
    }
    log(`live bundle (${assets.length} entry assets): names NEW ${hasNew}, names OLD ${hasOld}; index.html preconnect → ${(html.match(/preconnect" href="https:\/\/([a-z]+)\.supabase\.co/) || [])[1] || '?'}`);
    if (!hasNew || hasOld) die('the live bundle does not point (only) at the new project');
  },

  async 'cron-on'() {
    const oldActive = Number((await sql('OLD', 'select count(*) n from cron.job where active'))[0].n);
    if (oldActive > 0) die(`OLD still has ${oldActive} active cron jobs — never both`);
    await sql('NEW', 'select cron.alter_job(jobid, active := true) from cron.job', { ro: false });
    const [c] = await sql('NEW', 'select count(*) total, count(*) filter (where active) active from cron.job');
    log(`NEW cron: ${c.active}/${c.total} active`);
  },
  async 'cron-off'() {
    await sql('NEW', 'select cron.alter_job(jobid, active := false) from cron.job', { ro: false });
    const [c] = await sql('NEW', 'select count(*) total, count(*) filter (where active) active from cron.job');
    log(`NEW cron: ${c.active}/${c.total} active`);
  },
};

function vercelToken() {
  const line = readFileSync('D:/naturatherapy/vault.md', 'utf8').split(/\r?\n/)[59] || '';
  const tok = [...line.matchAll(/`([^`\s]{20,})`/g)].map((m) => m[1]).pop();
  if (!tok) die('Vercel token not found (D:\\naturatherapy\\vault.md line 60)');
  return tok;
}
async function vercelEnv(keys, ref) {
  if (!keys.url?.includes(ref) || !keys.anon) die(`the keys for ${ref} are not in .env`);
  const tok = vercelToken();
  const base = `https://api.vercel.com/v9/projects/${VERCEL.project}/env`;
  const H = { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' };
  const list = (await (await fetch(`${base}?teamId=${VERCEL.team}`, { headers: H })).json()).envs || [];
  const want = { VITE_SUPABASE_URL: keys.url, VITE_SUPABASE_PUBLISHABLE_KEY: keys.anon, VITE_SUPABASE_PROJECT_ID: ref };
  for (const [key, value] of Object.entries(want)) {
    const cur = list.find((e) => e.key === key && (e.target || []).includes('production'));
    if (!cur) die(`Vercel env ${key} (production) not found`);
    const r = await fetch(`${base}/${cur.id}?teamId=${VERCEL.team}`, { method: 'PATCH', headers: H, body: JSON.stringify({ value }) });
    if (!r.ok) die(`PATCH ${key} → ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  // read back, decrypted, and compare without printing
  let ok = 0;
  for (const [key, value] of Object.entries(want)) {
    const cur = list.find((e) => e.key === key && (e.target || []).includes('production'));
    const r = await fetch(`https://api.vercel.com/v1/projects/${VERCEL.project}/env/${cur.id}?teamId=${VERCEL.team}`, { headers: H });
    const j = await r.json();
    if (j.value === value) ok++;
    else log(`  ${key}: read-back differs (status ${r.status})`);
  }
  log(`Vercel Production env → ${ref}: ${ok}/3 verified by read-back`);
  if (ok !== 3) die('Vercel env not verified');
}

const cmd = process.argv[2];
if (!steps[cmd]) { console.error(`usage: cutover.mjs <${Object.keys(steps).join(' | ')}>`); process.exit(2); }
await steps[cmd]();
