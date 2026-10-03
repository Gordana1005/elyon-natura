#!/usr/bin/env node
/**
 * READ-ONLY size report for the Macedonian database.
 *
 *   node scripts/db-size-mk.mjs
 *
 * Why this exists: Supabase Free caps the database at 500 MB and it is a hard
 * stop — writes start failing, they don't slow down. Every index we add for
 * performance costs disk, and the pg_trgm GIN indexes for Orders search are the
 * expensive ones. Run this BEFORE creating any index, and again after.
 *
 * Issues only SELECTs, through the same Management API + `postgres` role that
 * scripts/apply-migration-mk.mjs uses. Refuses to run unless supabase/config.toml
 * points at the Macedonian ref (never Bulgaria).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'oufoazmnbwugtfldkwsn';

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

// Guard: never let this run against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = { ...process.env };
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) fail('SUPABASE_ACCESS_TOKEN missing');

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  return JSON.parse(text);
}

const mb = (bytes) => (Number(bytes) / 1024 / 1024).toFixed(1);
const bar = (pct) => {
  const n = Math.min(40, Math.max(0, Math.round(pct * 0.4)));
  return '█'.repeat(n) + '░'.repeat(40 - n);
};

// ── Total ──────────────────────────────────────────────────────────────────
const [{ total }] = await sql('select pg_database_size(current_database())::bigint as total;');
const FREE_CAP = 500 * 1024 * 1024;
const pct = (Number(total) / FREE_CAP) * 100;

console.log(`\n\x1b[1mDatabase size\x1b[0m — ${EXPECTED_REF}\n`);
console.log(`  ${mb(total)} MB of 500 MB  (${pct.toFixed(1)}% of the Supabase Free cap)`);
console.log(`  ${bar(pct)}`);
console.log(`  headroom: \x1b[1m${mb(FREE_CAP - Number(total))} MB\x1b[0m\n`);

// ── Per table ──────────────────────────────────────────────────────────────
const tables = await sql(`
  select c.relname                                      as name,
         pg_total_relation_size(c.oid)::bigint          as total,
         pg_table_size(c.oid)::bigint                   as heap,
         pg_indexes_size(c.oid)::bigint                 as indexes,
         c.reltuples::bigint                            as est_rows
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relkind = 'r'
   order by pg_total_relation_size(c.oid) desc
   limit 20;
`);

console.log('\x1b[1mLargest tables\x1b[0m  (total = heap + indexes + toast)\n');
console.log(`  ${'table'.padEnd(32)} ${'total'.padStart(9)} ${'heap'.padStart(9)} ${'indexes'.padStart(9)} ${'~rows'.padStart(9)}`);
console.log(`  ${'─'.repeat(32)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)} ${'─'.repeat(9)}`);
for (const t of tables) {
  console.log(
    `  ${t.name.padEnd(32)} ${(mb(t.total) + ' MB').padStart(9)} ${(mb(t.heap) + ' MB').padStart(9)} ` +
    `${(mb(t.indexes) + ' MB').padStart(9)} ${String(t.est_rows).padStart(9)}`,
  );
}

// ── Index detail on the tables this work touches ───────────────────────────
const idx = await sql(`
  select i.relname                        as index_name,
         t.relname                        as table_name,
         pg_relation_size(i.oid)::bigint  as size,
         x.idx_scan::bigint               as scans
    from pg_class i
    join pg_index ix on ix.indexrelid = i.oid
    join pg_class t  on t.oid = ix.indrelid
    join pg_namespace n on n.oid = i.relnamespace
    left join pg_stat_user_indexes x on x.indexrelid = i.oid
   where n.nspname = 'public'
     and t.relname in ('orders','order_items','prediction_segment_members','order_history','call_logs')
   order by pg_relation_size(i.oid) desc;
`);

const unused = idx.filter((r) => Number(r.scans || 0) === 0);
const idxTotal = idx.reduce((s, r) => s + Number(r.size), 0);

console.log(`\n\x1b[1mIndexes on the hot tables\x1b[0m — ${idx.length} indexes, ${mb(idxTotal)} MB total\n`);
console.log(`  ${'index'.padEnd(44)} ${'table'.padEnd(28)} ${'size'.padStart(9)} ${'scans'.padStart(10)}`);
console.log(`  ${'─'.repeat(44)} ${'─'.repeat(28)} ${'─'.repeat(9)} ${'─'.repeat(10)}`);
for (const r of idx) {
  const flag = Number(r.scans || 0) === 0 ? ' \x1b[33m← never used\x1b[0m' : '';
  console.log(
    `  ${r.index_name.padEnd(44)} ${r.table_name.padEnd(28)} ${(mb(r.size) + ' MB').padStart(9)} ` +
    `${String(r.scans ?? '—').padStart(10)}${flag}`,
  );
}

if (unused.length) {
  const reclaim = unused.reduce((s, r) => s + Number(r.size), 0);
  console.log(
    `\n  \x1b[33m${unused.length} index(es) have never been scanned — dropping them would reclaim ${mb(reclaim)} MB.\x1b[0m` +
    `\n  (Check first: stats reset on restore, and unique/PK indexes must stay regardless.)`,
  );
}

// ── Verdict on the trigram plan ────────────────────────────────────────────
const ordersRow = tables.find((t) => t.name === 'orders');
if (ordersRow) {
  // Trigram GIN over 4 text columns is empirically ~0.5–1.5× the heap size of
  // those columns. Rough upper bound: ~25% of the orders heap, per column set.
  const estTrgm = Number(ordersRow.heap) * 0.25;
  const after = Number(total) + estTrgm;
  console.log(`\n\x1b[1mVerdict — pg_trgm search indexes (Phase 4)\x1b[0m\n`);
  console.log(`  rough estimate      ~${mb(estTrgm)} MB for the 4 search columns`);
  console.log(`  projected total     ~${mb(after)} MB  (${((after / FREE_CAP) * 100).toFixed(1)}% of cap)`);
  console.log(
    after < FREE_CAP * 0.8
      ? `  \x1b[32m✓ affordable on Free\x1b[0m — proceed, but re-run this after creating them.\n`
      : `  \x1b[31m✗ too tight on Free\x1b[0m — defer trigram search, or move to Pro (8 GB).\n`,
  );
}
