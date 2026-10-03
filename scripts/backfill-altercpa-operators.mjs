#!/usr/bin/env node
/**
 * Put the AlterCPA operator's NAME onto the imported orders.
 *
 *   node scripts/backfill-altercpa-operators.mjs            # dry run + confidence report
 *   node scripts/backfill-altercpa-operators.mjs --commit
 *   node scripts/backfill-altercpa-operators.mjs --map operators.csv --commit
 *
 * ── Why this is derived rather than looked up ──
 * AlterCPA's API returns operators only as integers. `user` is whoever handled
 * the lead, `app` is whoever approved it (set on 24,759 of the 24,766 approved
 * orders, and equal to `user` 99.9% of the time). It never returns a name, and
 * there is no directory endpoint — I probed 18 candidates and only list.json,
 * stats.json and an undocumented goods.json exist; the latter two are empty for
 * this account. The names exist solely in the cpa.moe web UI.
 *
 * So the names are RECOVERED from collabBox instead. Every collabBox document
 * is a paid order stamped with the operator who raised it (`Автор`), and 4,881
 * of them are matched to an AlterCPA order. Tallying author against `app` gives
 * an id → name map, and the evidence is lopsided enough to be convincing:
 * app 3806 → Јована Гаврилоска on 53 of 53, app 3086 → Виолета Догова on 152 of
 * 159, app 3453 → Сашка Симоновска on 272 of 287.
 *
 * It also self-validates. Three names fall out of the arithmetic that appear in
 * the AlterCPA UI screenshot the operator sent — Александра Христоска, Санела
 * Џоговиќ, Снежана Стојковска — which nothing in this pipeline could have known.
 *
 * A handful of ids stay ambiguous (2737, 2821, 3055, 3054, 3060, 3117: no name
 * above ~50%). Those are the OLDEST accounts, so they read as shared logins
 * from before per-operator accounts existed. They are left blank rather than
 * guessed, and `--map` accepts a real id→name CSV to override everything here.
 *
 * ── Names go in name-only columns, never an id ──
 * confirmed_by_agent_id and assigned_agent_id stay NULL. Commission is credited
 * via salesOwnerId (confirmed_by_agent_id ?? assigned_agent_id), so filling
 * either would create a payout claim against 27,276 historical orders. Workload
 * counts and the Unassign tab also key on assigned_agent_id, so a name alone
 * cannot put these orders into anyone's queue.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders, isTestOrder, normalizeMkPhone } from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const SOURCE = 'altercpa';
const args = process.argv.slice(2);
const COMMIT = args.includes('--commit');
const MAP_CSV = (() => { const i = args.indexOf('--map'); return i >= 0 ? args[i + 1] : null; })();

const MIN_CONFIDENCE = 0.80;
const MIN_EVIDENCE = 10;

const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const sql = async (query) => {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return t ? JSON.parse(t) : [];
};

const orders = readOrders(join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl'));
const live = orders.filter((o) => !isTestOrder(o) && normalizeMkPhone(o.phone));

// ── build the id → name map ───────────────────────────────────────────────
let nameById = new Map();
const report = [];

// A real list from AlterCPA beats anything derived — take it verbatim.
const DEFAULT_MAP = join(ROOT, 'scripts', 'data', 'altercpa-operators.json');
const mapPath = MAP_CSV || (existsSync(DEFAULT_MAP) ? DEFAULT_MAP : null);

if (mapPath && existsSync(mapPath)) {
  if (mapPath.endsWith('.json')) {
    const { operators } = JSON.parse(readFileSync(mapPath, 'utf8'));
    for (const [id, name] of Object.entries(operators)) nameById.set(Number(id), name);
  } else {
    for (const line of readFileSync(mapPath, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
      const c = line.split(';');
      const id = Number(c[1]); const name = (c[6] || '').trim();
      if (id && name && !/^name/i.test(name)) nameById.set(id, name);
    }
  }
  console.log(`Using ${mapPath}: ${nameById.size} operators named.`);
  // The AlterCPA users screen lists only ACTIVE accounts, so operators who have
  // since left are absent — and between them they handled ~42k orders. Fill
  // those gaps from the collabBox derivation, which the screen just validated:
  // every id it accepted at >=80% matched the real list exactly, and every id
  // it rejected would have been wrong. Authoritative names always win.
  deriveFromCollabBox(nameById, /* onlyMissing */ true);
} else {
  deriveFromCollabBox(nameById, false);
}

function deriveFromCollabBox(target, onlyMissing) {
  const byId = new Map(orders.map((o) => [String(o.id), o]));
  const rows = readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-corrections.csv'), 'utf8')
    .replace(/^﻿/, '').split('\n').slice(1).map((l) => l.split(';'));
  const H = rows[0]; const ix = Object.fromEntries(H.map((h, i) => [h, i]));
  const evidence = new Map();
  for (const r of rows.slice(1)) {
    if (r.length < 10 || !r[ix.altercpa_id]) continue;
    const o = byId.get(r[ix.altercpa_id]);
    if (!o || !o.app) continue;
    const author = (r[ix.collabbox_author] || '').replace(/\s+/g, ' ').trim();
    if (!author) continue;
    if (!evidence.has(o.app)) evidence.set(o.app, new Map());
    const m = evidence.get(o.app);
    m.set(author, (m.get(author) || 0) + 1);
  }
  const vol = new Map();
  for (const o of live) for (const f of ['user', 'app']) if (o[f]) vol.set(o[f], (vol.get(o[f]) || 0) + 1);

  let added = 0;
  for (const [id, names] of evidence) {
    // An authoritative name always wins. Without this the derived Cyrillic
    // spelling would overwrite AlterCPA's own — storing "Даниела Крстевска"
    // over the real "Dance Krstevska", and silently losing the tie back to the
    // source system.
    if (onlyMissing && target.has(id)) continue;
    const ranked = [...names].sort((a, b) => b[1] - a[1]);
    const n = ranked.reduce((a, b) => a + b[1], 0);
    const conf = ranked[0][1] / n;
    const accept = conf >= MIN_CONFIDENCE && n >= MIN_EVIDENCE;
    if (accept) { target.set(id, ranked[0][0]); added++; }
    report.push({ id, name: ranked[0][0], conf, evidence: n, orders: vol.get(id) || 0, accept });
  }
  report.sort((a, b) => b.orders - a.orders);
  console.log(`${onlyMissing ? 'Gaps filled from' : 'Derived from'} collabBox: ${added} more operator ids`
    + ` (>=${(100 * MIN_CONFIDENCE).toFixed(0)}% dominance on >=${MIN_EVIDENCE} matched orders)`);
  console.log('  id      orders  evidence  conf  name');
  for (const r of report) {
    console.log(`  ${r.accept ? '\x1b[32m✓\x1b[0m' : '\x1b[33m·\x1b[0m'} ${String(r.id).padEnd(6)}${String(r.orders).padStart(7)}${String(r.evidence).padStart(9)}  ${(100 * r.conf).toFixed(0).padStart(3)}%  ${r.name}${r.accept ? '' : '   ← ambiguous, left blank'}`);
  }
}

// ── decide what each order gets ───────────────────────────────────────────
const confirmedBy = [];   // who approved it  → confirmed_by_name
const handledBy = [];     // who worked it    → assigned_agent_name
for (const o of live) {
  const app = o.app && nameById.get(o.app);
  const user = o.user && nameById.get(o.user);
  if (app) confirmedBy.push([String(o.id), app]);
  if (user) handledBy.push([String(o.id), user]);
}
console.log(`\norders that gain a confirmer name : ${confirmedBy.length.toLocaleString('en-US')}`);
console.log(`orders that gain a handler name   : ${handledBy.length.toLocaleString('en-US')}`);
console.log(`of ${live.length.toLocaleString('en-US')} imported orders`);

if (!COMMIT) {
  console.log('\nDRY RUN — nothing written. Re-run with --commit.');
  console.log('To use a real list instead of the derivation:');
  console.log('  node scripts/backfill-altercpa-operators.mjs --map scripts/data/altercpa-operators-to-name.csv --commit');
  process.exit(0);
}

const snap = join(ROOT, 'scripts', 'data', `operators-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(snap, JSON.stringify({
  note: "Before naming operators. confirmed_by_name was the literal 'Import' on real-status rows and NULL elsewhere; assigned_agent_name was NULL throughout. No *_agent_id was touched.",
  map: Object.fromEntries(nameById), confirmed: confirmedBy.length, handled: handledBy.length,
}, null, 2));
console.log(`\nrollback note → ${snap}`);

const CHUNK = 2000;
for (const [col, pairs] of [['confirmed_by_name', confirmedBy], ['assigned_agent_name', handledBy]]) {
  if (!pairs.length) continue;
  console.log(`\n${col}: ${pairs.length.toLocaleString('en-US')} rows`);
  let done = 0;
  for (let i = 0; i < pairs.length; i += CHUNK) {
    const vs = pairs.slice(i, i + CHUNK)
      .map(([id, name]) => `('${id}','${name.replace(/'/g, "''")}')`).join(',');
    const out = await sql(`update public.orders o set ${col} = v.name
      from (values ${vs}) as v(ext, name)
      where o.external_source = '${SOURCE}' and o.external_order_id = v.ext
      returning 1;`);
    done += out.length;
    process.stdout.write(`\r  updated ${done.toLocaleString('en-US')}   `);
  }
  console.log();
}

// The whole point of the name-only rule — prove no id was written.
const [{ ids }] = await sql(`select count(*)::int ids from public.orders
  where external_source='${SOURCE}' and (confirmed_by_agent_id is not null or assigned_agent_id is not null);`);
console.log(`\norders carrying an agent ID (must be 0): ${ids}`);
if (ids) { console.error('✗ An agent id was written — this would create commission liability.'); process.exit(1); }

console.log('\ntop operators by confirmed orders:');
console.table(await sql(`select confirmed_by_name operator, count(*)::int orders,
    count(*) filter (where status='paid')::int paid,
    round(sum(price) filter (where status='paid')::numeric,0) paid_eur
  from public.orders where external_source='${SOURCE}' and confirmed_by_name is not null
    and confirmed_by_name <> 'Import'
  group by 1 order by 3 desc limit 15;`));
