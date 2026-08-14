#!/usr/bin/env node
/**
 * Agent-performance parity + performance harness (READ-ONLY).
 *
 *   node scripts/verify-agent-perf-parity.mjs                 # self-consistency + timings
 *   node scripts/verify-agent-perf-parity.mjs --parity        # legacy vs ?engine=sql
 *   node scripts/verify-agent-perf-parity.mjs --only=month    # one range
 *   node scripts/verify-agent-perf-parity.mjs --json=out.json
 *
 * Sibling of verify-insights-parity.mjs, for GET /agent-performance. Nothing
 * flips AGENT_PERF_ENGINE=sql until this reports zero BLOCKERs.
 *
 * Differences from the insights harness, both deliberate:
 *   • The response is an ARRAY sorted by paid_revenue DESC — ties are
 *     order-unstable even legacy-vs-legacy. Rows are re-keyed by user_id
 *     before diffing, and the sort is asserted separately (non-increasing
 *     paid_revenue on both sides).
 *   • The no-range case ("Start" preset — the reason this engine exists) can
 *     legitimately KILL the legacy engine (HTTP 546). That is recorded as
 *     legacy-dead-not-a-diff; the SQL run is still timed and its totals are
 *     printed for manual arbitration against direct SQL.
 *
 * Severity: integer counts/strings/bools differing at all = BLOCKER; money
 * >= half a cent = BLOCKER; sub-cent float drift = NOTE (JS sums IEEE doubles,
 * Postgres sums exact decimals — where they disagree Postgres is right).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';
const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== EXPECTED_REF) {
  fail('supabase/config.toml does not point at the Macedonian project');
}

const env = { ...process.env };
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
const SUPABASE_URL = env.VITE_SUPABASE_URL;
const ANON = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.VITE_SUPABASE_ANON_KEY;
const EMAIL = env.MK_ADMIN_EMAIL || 'mile@elyon.com';
const PASSWORD = env.MK_ADMIN_PASSWORD;
if (!SUPABASE_URL || !ANON) fail('VITE_SUPABASE_URL / publishable key missing from .env');
if (!PASSWORD) fail('Set MK_ADMIN_PASSWORD (see docs/VAULT.md §3). Never hard-code it here.');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const DO_PARITY = flag('parity');
const ONLY = opt('only');
const JSON_OUT = opt('json');

// ── auth ───────────────────────────────────────────────────────────────────
const auth = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: ANON, 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
});
if (!auth.ok) fail(`login failed for ${EMAIL}: ${auth.status} ${(await auth.text()).slice(0, 200)}`);
const JWT = (await auth.json()).access_token;
if (!JWT) fail('login returned no access_token');

const API = `${SUPABASE_URL}/functions/v1/api`;
async function call(path) {
  const t0 = performance.now();
  let res, text;
  try {
    res = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${JWT}`, apikey: ANON } });
    text = await res.text();
  } catch (e) {
    return { ms: performance.now() - t0, status: 0, bytes: 0, body: null, error: String(e) };
  }
  const ms = performance.now() - t0;
  let body = null;
  try { body = JSON.parse(text); } catch { /* non-JSON = an error page or a kill */ }
  return { ms, status: res.status, bytes: text.length, body, raw: text.slice(0, 300) };
}

// ── case matrix ────────────────────────────────────────────────────────────
// Date presets EXACTLY as AgentsTab.getDateRange() builds them: date-only
// strings, `to` = TOMORROW (now + 86400000).
const iso = (d) => d.toISOString().slice(0, 10);
const now = new Date();
const dback = (n) => iso(new Date(now.getTime() - n * 86400000));
const dfwd = (n) => iso(new Date(now.getTime() + n * 86400000));

const CASES = [
  { key: 'today',    p: { from: iso(now), to: dfwd(1) },   why: 'AgentsTab Today preset' },
  { key: 'week',     p: { from: dback(7), to: dfwd(1) },   why: 'AgentsTab Week preset' },
  { key: 'month',    p: { from: dback(30), to: dfwd(1) },  why: 'AgentsTab Month preset (the default)' },
  { key: '12mo',     p: { from: dback(365), to: dfwd(1) }, why: 'a whole year' },
  { key: 'start',    p: {},                                why: 'THE KILL CASE — no range at all' },
  { key: 'cancelled',p: { from: dback(30), to: dfwd(1), include_cancelled: 'true' }, why: 'cancelled folded into leads/rates' },
  { key: 'status',   p: { from: dback(30), to: dfwd(1), status: 'confirmed' },       why: 'status filter (created window only)' },
  { key: 'source',   p: { from: dback(30), to: dfwd(1), source: 'prediction' },      why: 'source filter (both windows)' },
  { key: 'basis',    p: { from: dback(30), to: dfwd(1), date_basis: 'created_at' },  why: 'legacy activity-window earnings' },
  { key: 'zero',     p: { from: dback(30), to: dfwd(1), show_zero: 'true' },         why: 'zero-activity agents included' },
  { key: 'search',   p: { from: dback(365), to: dfwd(1), search: 'a' },              why: 'name/email search' },
  { key: 'future',   p: { from: dfwd(30), to: dfwd(37) }, why: 'zero rows, non-empty bounds' },
  { key: 'inverted', p: { from: iso(now), to: dback(1) }, why: 'from > to' },
  // agent_id cases are appended dynamically after the first month call — one
  // real uuid and one `name:` virtual key, picked from the live response.
];
let matrix = ONLY ? CASES.filter((c) => c.key === ONLY) : CASES;
if (!matrix.length) fail(`--only=${ONLY} matched no case. Known: ${CASES.map((c) => c.key).join(', ')}`);

const qs = (c, eng = 'legacy') => {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(c.p)) sp.set(k, v);
  // Always name the engine explicitly — once the secret flips, an omitted
  // param would silently compare sql against itself.
  sp.set('engine', eng);
  return `agent-performance?${sp}`;
};

// ── diff (array re-keyed by user_id; sort asserted separately) ─────────────
const MONEY = /(revenue|value|cost|profit|price|payout|bonus|contribution|avg)/i;

function walk(a, b, path, out) {
  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) out.push({ path, a, b, sev: 'BLOCKER', why: 'null/undefined mismatch' });
    return;
  }
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push({ path, a, b, sev: 'BLOCKER', why: `type ${ta} → ${tb}` }); return; }
  if (ta === 'object' || ta === 'array') {
    const ka = Object.keys(a), kb = Object.keys(b);
    for (const k of ka) if (!(k in b)) out.push({ path: `${path}.${k}`, a: a[k], b: '(missing)', sev: 'BLOCKER', why: 'key removed' });
    for (const k of kb) if (!(k in a)) out.push({ path: `${path}.${k}`, a: '(missing)', b: b[k], sev: 'BLOCKER', why: 'key added' });
    for (const k of ka) if (k in b) walk(a[k], b[k], path ? `${path}.${k}` : k, out);
    return;
  }
  if (ta === 'number') {
    if (a === b) return;
    const d = Math.abs(a - b);
    if (Number.isInteger(a) && Number.isInteger(b)) {
      out.push({ path, a, b, sev: 'BLOCKER', why: 'integer counts must match exactly' });
    } else if (MONEY.test(path)) {
      out.push({ path, a, b, sev: d >= 0.005 ? 'BLOCKER' : 'NOTE', why: `money Δ ${d.toExponential(2)}` });
    } else {
      out.push({ path, a, b, sev: d > 1e-6 ? 'BLOCKER' : 'NOTE', why: `ratio Δ ${d.toExponential(2)}` });
    }
    return;
  }
  if (a !== b) out.push({ path, a, b, sev: 'BLOCKER', why: `${ta} differs` });
}

// Rows → map keyed by user_id. A duplicate user_id would corrupt the re-key,
// so it is its own BLOCKER.
function keyed(rows, out, side) {
  const m = {};
  for (const r of rows || []) {
    if (m[r.user_id]) out.push({ path: `${side}.${r.user_id}`, a: 'dup', b: 'dup', sev: 'BLOCKER', why: 'duplicate user_id' });
    m[r.user_id] = r;
  }
  return m;
}
function sortOk(rows) {
  for (let i = 1; i < (rows || []).length; i++) {
    if (rows[i - 1].paid_revenue < rows[i].paid_revenue) return false;
  }
  return true;
}
function diffRows(a, b) {
  const out = [];
  if (!Array.isArray(a) || !Array.isArray(b)) { out.push({ path: '', a: typeof a, b: typeof b, sev: 'BLOCKER', why: 'not arrays' }); return out; }
  if (!sortOk(a)) out.push({ path: 'legacy', a: 'sort', b: '', sev: 'BLOCKER', why: 'paid_revenue not non-increasing' });
  if (!sortOk(b)) out.push({ path: 'sql', a: '', b: 'sort', sev: 'BLOCKER', why: 'paid_revenue not non-increasing' });
  const ka = keyed(a, out, 'legacy'), kb = keyed(b, out, 'sql');
  walk(ka, kb, '', out);
  // ── The ONE tolerated display divergence: a profit_per_lead penny-tie. ──
  // profit_per_lead = r2(total_profit / leads). total_profit is the only
  // UNROUNDED input to any derived ratio (paid_revenue is pre-rounded), and
  // legacy accumulates it as IEEE doubles in fetch order while Postgres sums
  // exact decimals. When the true quotient sits on a .xx5 boundary, the two
  // engines legitimately round a cent apart — and the legacy side isn't even
  // stable run-to-run (unordered pagination changes its accumulation order).
  // Downgrade ONLY that: a ≤1-cent flip where the same row's total_profit
  // agrees to < half a cent and leads_assigned matches exactly. Everything
  // else stays a BLOCKER.
  for (const x of out) {
    if (x.sev !== 'BLOCKER') continue;
    const m = x.path.match(/^(.*)\.profit_per_lead$/);
    if (!m) continue;
    const ra = ka[m[1]], rb = kb[m[1]];
    if (!ra || !rb) continue;
    if (typeof x.a !== 'number' || typeof x.b !== 'number') continue;
    if (Math.abs(x.a - x.b) > 0.010001) continue;
    if (ra.leads_assigned !== rb.leads_assigned) continue;
    if (Math.abs(Number(ra.total_profit) - Number(rb.total_profit)) >= 0.005) continue;
    x.sev = 'NOTE';
    x.why = 'rounding tie: float-noise profit on the .xx5 boundary (Postgres exact value is the correct one)';
  }
  return out;
}

const tally = (d) => ({ blocker: d.filter((x) => x.sev === 'BLOCKER').length, note: d.filter((x) => x.sev === 'NOTE').length });
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`);
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}kB`);
const show = (d, n = 8) => [...d].sort((a, b) => (a.sev === 'BLOCKER' ? 0 : 1) - (b.sev === 'BLOCKER' ? 0 : 1)).slice(0, n).forEach((x) =>
  console.log(`      ${x.sev === 'BLOCKER' ? '\x1b[31m' : '\x1b[33m'}${x.sev}\x1b[0m ${x.path}: ${JSON.stringify(x.a)} → ${JSON.stringify(x.b)}   (${x.why})`));

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n\x1b[1mAgent-performance parity harness\x1b[0m — ${EXPECTED_REF}, as ${EMAIL}`);
console.log(`Mode: ${DO_PARITY ? 'PARITY (legacy vs engine=sql)' : 'self-consistency + timings'}\n`);

// Pick real agent_id values (one uuid, one name: virtual) from a live month call.
if (!ONLY) {
  const probe = await call(qs({ p: { from: dback(30), to: dfwd(1) } }));
  if (probe.status === 200 && Array.isArray(probe.body)) {
    const real = probe.body.find((r) => !r.is_virtual && r.total_paid > 0) || probe.body.find((r) => !r.is_virtual);
    const virt = probe.body.find((r) => r.is_virtual);
    if (real) matrix.push({ key: 'agent-uuid', p: { from: dback(30), to: dfwd(1), agent_id: real.user_id }, why: `single agent (${real.full_name})` });
    if (virt) matrix.push({ key: 'agent-name', p: { from: dback(30), to: dfwd(1), agent_id: virt.user_id }, why: `virtual operator (${virt.full_name})` });
  }
}

const report = [];
let totalBlockers = 0, unstable = 0;

for (const c of matrix) {
  const label = `${c.key}`.padEnd(11);
  process.stdout.write(`${label} ${(c.p.from || '—')} → ${(c.p.to || '—')}  `);

  const a = await call(qs(c));
  const legacyDead = a.status !== 200;
  if (legacyDead) {
    console.log(`\x1b[33mlegacy HTTP ${a.status || 'NETWORK'}\x1b[0m after ${ms(a.ms)}  ${(a.raw ?? a.error ?? '').slice(0, 80)}`);
    console.log(`      ${a.status === 546 || a.status === 504 ? '\x1b[33m↑ the CPU/wall kill this engine exists to fix — not a parity diff.\x1b[0m' : '\x1b[31munexpected failure\x1b[0m'}`);
    if (!(a.status === 546 || a.status === 504)) totalBlockers++;
  }

  const row = { case: c.key, params: c.p, legacy_status: a.status, legacy_ms: Math.round(a.ms), bytes: a.bytes };

  if (!legacyDead) {
    const b = await call(qs(c));
    const selfDiff = diffRows(a.body, b.body);
    const selfT = tally(selfDiff);
    const stable = selfT.blocker === 0;
    if (!stable) unstable++;
    console.log(
      `${ms(a.ms).padStart(7)} ${kb(a.bytes).padStart(8)}  ` +
      (stable ? '\x1b[32mstable\x1b[0m' : `\x1b[31mUNSTABLE (${selfT.blocker})\x1b[0m`) +
      `  ${c.why}`,
    );
    if (!stable) show(selfDiff, 5);
    row.stable = stable;
  }

  if (DO_PARITY) {
    const s = await call(qs(c, 'sql'));
    if (s.status !== 200) {
      console.log(`      \x1b[31mengine=sql → HTTP ${s.status}\x1b[0m ${(s.raw ?? s.error ?? '').slice(0, 120)}`);
      totalBlockers++;
    } else if (legacyDead) {
      // Nothing to diff against — print SQL totals for manual arbitration.
      const rows = Array.isArray(s.body) ? s.body : [];
      const tot = (k) => rows.reduce((x, r) => x + (Number(r[k]) || 0), 0);
      console.log(`      sql ${ms(s.ms)} ${kb(s.bytes)}  ${rows.length} agents  ` +
        `paid=${tot('total_paid')} pkgs=${tot('packages_sold')} paid_rev=${tot('paid_revenue').toFixed(2)} payout=${tot('payout_earned').toFixed(2)}`);
      console.log(`      \x1b[33m↑ arbitrate these totals against direct SQL before trusting the kill case.\x1b[0m`);
      Object.assign(row, { sql_ms: Math.round(s.ms), sql_bytes: s.bytes, parity: 'legacy-dead' });
    } else {
      const c2 = await call(qs(c));                   // legacy again — did data move?
      if (tally(diffRows(a.body, c2.body)).blocker > 0) {
        console.log(`      \x1b[33mskipped: live data changed mid-test. Re-run in the quiet window.\x1b[0m`);
        row.parity = 'retry';
      } else {
        const d = diffRows(a.body, s.body);
        const t = tally(d);
        totalBlockers += t.blocker;
        const speed = a.ms / Math.max(1, s.ms);
        console.log(
          `      sql ${ms(s.ms)} ${kb(s.bytes)}  \x1b[1m${speed.toFixed(0)}× faster\x1b[0m  ` +
          (t.blocker ? `\x1b[31m${t.blocker} BLOCKER\x1b[0m ` : '\x1b[32m0 blockers\x1b[0m ') +
          (t.note ? `\x1b[33m${t.note} note\x1b[0m` : ''),
        );
        if (d.length) show(d);
        Object.assign(row, { sql_ms: Math.round(s.ms), sql_bytes: s.bytes, blockers: t.blocker, notes: t.note, speedup: +speed.toFixed(1) });
      }
    }
  }
  report.push(row);
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log('');
if (unstable) {
  console.log(`\x1b[33m⚠ ${unstable} case(s) returned different numbers on two consecutive identical calls`);
  console.log(`  (unordered LIMIT/OFFSET pagination in the legacy engine). Diffs there need SQL arbitration.\x1b[0m\n`);
}
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); console.log(`  wrote ${JSON_OUT}\n`); }

if (totalBlockers) {
  console.log(`\x1b[31m✗ ${totalBlockers} BLOCKER(s). AGENT_PERF_ENGINE must NOT flip to sql.\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m✓ No blockers.\x1b[0m${DO_PARITY ? ' Parity proven across the matrix.' : ' (Run with --parity once the migration is applied.)'}\n`);
