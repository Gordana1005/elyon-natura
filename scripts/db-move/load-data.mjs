#!/usr/bin/env node
/**
 * scripts/db-move/load-data.mjs — load exports/db-move/<date>/auth-data.sql + data.sql into the NEW project,
 * table by table, resumable (03.10.2026).
 *
 *   node scripts/db-move/load-data.mjs [YYYY-MM-DD] [--min-rows-for-index-drop 20000] [--no-index-drop]
 *
 * Why not one transaction: on Small compute the single-transaction load of orders (360k wide rows, ~30 indexes)
 * killed a backend ("another server process exited abnormally") and rolled everything back. Here:
 *   - every COPY commits on its own (autocommit), under session_replication_role = replica (no triggers, no FKs);
 *   - a table whose row count already equals the dump's is skipped → a crash costs one table, rerun resumes;
 *   - for big tables the plain indexes (not the constraint-backed ones) are DROPPED before the load and
 *     CREATEd again after, from schema.sanitized.sql — far less memory and time while copying;
 *   - the dump's setval() statements run at the end, then ANALYZE.
 * Never touches the source project. The live Bulgarian project is refused by name.
 */
import { createReadStream, createWriteStream, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TARGET_REF = 'oufoazmnbwugtfldkwsn';
const BG_REF = 'sxymaloycddnoxudxaqp';
const HOST = 'aws-0-eu-central-1.pooler.supabase.com';
const PG = 'C:/Program Files/PostgreSQL/17/bin';
const args = process.argv.slice(2);
const date = args.find((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)) || '2026-10-03';
const MIN_ROWS = Number(args.includes('--min-rows-for-index-drop') ? args[args.indexOf('--min-rows-for-index-drop') + 1] : 20000);
const DROP_INDEXES = !args.includes('--no-index-drop');
const OUT = join(ROOT, 'exports', 'db-move', date);
const PGPASS = join(OUT, 'pgpass.conf');
if (TARGET_REF === BG_REF) throw new Error('refusing Bulgaria');
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const die = (m) => { console.error(`✗ ${m}`); process.exit(1); };
const DSN = `postgresql://postgres.${TARGET_REF}@${HOST}:5432/postgres?sslmode=require`;
const PGENV = { ...process.env, PGPASSFILE: PGPASS, PGSSLMODE: 'require', PGCONNECT_TIMEOUT: '30', PGCLIENTENCODING: 'UTF8' };
const SESSION = ['set statement_timeout = 0', 'set lock_timeout = 0', 'set idle_in_transaction_session_timeout = 0', 'set session_replication_role = replica'];

function q(sql) {
  const r = spawnSync(`${PG}/psql.exe`, ['--dbname', DSN, '-X', '-q', '-At', '-w', '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8', env: PGENV });
  if (r.status !== 0) die(`query failed: ${(r.stderr || '').slice(0, 800)}\n${sql.slice(0, 200)}`);
  return (r.stdout || '').trim();
}
function psqlFile(label, file) {
  const a = ['--dbname', DSN, '-X', '-q', '-v', 'ON_ERROR_STOP=1'];
  for (const c of SESSION) a.push('-c', c);
  a.push('-f', file);
  const t0 = Date.now();
  const r = spawnSync(`${PG}/psql.exe`, a, { stdio: 'inherit', env: PGENV });
  const sec = Math.round((Date.now() - t0) / 1000);
  if (r.status !== 0) die(`${label} failed after ${sec}s (exit ${r.status}) — rerun to resume`);
  log(`${label} done in ${sec}s`);
}

// 1) index the dump: one streaming pass → blocks {table, start, rows}; the trailing non-COPY statements (setval) kept
const blocksFile = join(OUT, 'data-blocks.json');
let blocks;
if (existsSync(blocksFile)) blocks = JSON.parse(readFileSync(blocksFile, 'utf8'));
else {
  log('indexing data.sql …');
  blocks = []; let cur = null; let n = 0;
  for await (const line of createInterface({ input: createReadStream(join(OUT, 'data.sql'), { encoding: 'utf8' }), crlfDelay: Infinity })) {
    n++;
    if (cur) { if (line === '\\.') { cur.end = n; cur = null; } else cur.rows++; continue; }
    const m = line.match(/^COPY "public"\."([^"]+)" \(/);
    if (m) { cur = { table: m[1], start: n, rows: 0 }; blocks.push(cur); }
  }
  writeFileSync(blocksFile, JSON.stringify({ lines: n, blocks }, null, 1));
  blocks = { lines: n, blocks };
}
log(`data.sql: ${blocks.blocks.length} tables, ${blocks.lines} lines`);

// 2) what is already in: a table is done when its count equals the dump's rows
const counts = Object.fromEntries(q(`select string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text), ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`).split(',').filter(Boolean).map((kv) => { const i = kv.lastIndexOf('='); return [kv.slice(0, i), Number(kv.slice(i + 1))]; }));
const todo = blocks.blocks.filter((b) => counts[b.table] !== b.rows);
const partial = todo.filter((b) => counts[b.table] > 0);
log(`tables to load: ${todo.length} (done ${blocks.blocks.length - todo.length}); partially loaded (will be truncated first): ${partial.map((b) => b.table).join(', ') || 'none'}`);
for (const b of partial) q(`set session_replication_role = replica; truncate table only public."${b.table}"`);

// 3) auth data first (users + identities), if missing
const users = Number(q('select count(*) from auth.users'));
if (users === 0) psqlFile('auth-data', join(OUT, 'auth-data.sql'));
else log(`auth.users already ${users}`);

// 4) indexes of the big tables: drop before, create after (from schema.sanitized.sql)
const schema = readFileSync(join(OUT, 'schema.sanitized.sql'), 'utf8');
const bigTables = todo.filter((b) => b.rows >= MIN_ROWS).map((b) => b.table);
const createIndex = [];
if (DROP_INDEXES) {
  for (const t of bigTables) {
    const re = new RegExp(`^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"([^"]+)" ON "public"\\."${t}"[^;]*;`, 'gm');
    for (const m of schema.matchAll(re)) createIndex.push({ table: t, name: m[1], sql: m[0] });
  }
  const names = createIndex.map((i) => i.name);
  const existing = names.length ? q(`select string_agg(indexname, ',') from pg_indexes where schemaname='public' and indexname in (${names.map((n) => `'${n}'`).join(',')})`).split(',').filter(Boolean) : [];
  log(`big tables (≥ ${MIN_ROWS} rows): ${bigTables.join(', ') || 'none'}; plain indexes to drop now and rebuild after: ${existing.length}`);
  if (existing.length) q(existing.map((n) => `drop index if exists public."${n}"`).join('; '));
  writeFileSync(join(OUT, 'indexes-to-rebuild.json'), JSON.stringify(createIndex, null, 1));
}

// 5) the filtered dump: only the tables still to load, plus every non-COPY statement (SETs, setval)
const filtered = join(OUT, 'data.filtered.sql');
{
  const skip = new Set(blocks.blocks.filter((b) => !todo.some((t) => t.table === b.table)).map((b) => b.table));
  const out = createWriteStream(filtered, { encoding: 'utf8' });
  let skipping = false; let kept = 0;
  for await (const line of createInterface({ input: createReadStream(join(OUT, 'data.sql'), { encoding: 'utf8' }), crlfDelay: Infinity })) {
    if (skipping) { if (line === '\\.') skipping = false; continue; }
    const m = line.match(/^COPY "public"\."([^"]+)" \(/);
    if (m && skip.has(m[1])) { skipping = true; continue; }
    if (m) kept++;
    out.write(line + '\n');
  }
  await new Promise((res) => out.end(res));
  log(`data.filtered.sql written: ${kept} COPY blocks`);
}

// 6) load (autocommit: one commit per COPY)
psqlFile('data (table by table)', filtered);

// 7) rebuild the dropped indexes, one statement each (a failure stops; rerun with --from-indexes is just rerunning this script)
if (DROP_INDEXES && createIndex.length) {
  const have = q(`select string_agg(indexname, ',') from pg_indexes where schemaname='public'`).split(',');
  const missing = createIndex.filter((i) => !have.includes(i.name));
  log(`rebuilding ${missing.length} indexes …`);
  const t0 = Date.now();
  for (const i of missing) {
    const t1 = Date.now();
    q(`set statement_timeout = 0; set maintenance_work_mem = '256MB'; ${i.sql}`);
    log(`  ${i.table}.${i.name} ${Math.round((Date.now() - t1) / 1000)}s`);
  }
  log(`indexes rebuilt in ${Math.round((Date.now() - t0) / 1000)}s`);
}

// 8) proof + stats
const after = Object.fromEntries(q(`select string_agg(format('%s=%s', c.relname, (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')))[1]::text), ',') from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'`).split(',').filter(Boolean).map((kv) => { const i = kv.lastIndexOf('='); return [kv.slice(0, i), Number(kv.slice(i + 1))]; }));
const wrong = blocks.blocks.filter((b) => after[b.table] !== b.rows);
if (wrong.length) die(`row counts differ from the dump: ${wrong.map((b) => `${b.table} ${after[b.table]}≠${b.rows}`).join(', ')}`);
log(`all ${blocks.blocks.length} tables match the dump; orders=${after.orders} order_items=${after.order_items}; auth.users=${q('select count(*) from auth.users')}`);
q('set statement_timeout = 0; analyze');
log('DONE');
