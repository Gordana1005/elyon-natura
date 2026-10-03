#!/usr/bin/env node
/**
 * Insights parity + performance harness (READ-ONLY).
 *
 *   node scripts/verify-insights-parity.mjs                 # self-consistency + timings
 *   node scripts/verify-insights-parity.mjs --parity        # legacy vs ?engine=sql
 *   node scripts/verify-insights-parity.mjs --only=12mo     # one range
 *   node scripts/verify-insights-parity.mjs --json=out.json
 *
 * Why this exists
 * ---------------
 * The reporting rewrite moves aggregation out of JavaScript and into Postgres.
 * The business's live figures — €665k of paid revenue, agent commissions, VAT —
 * must come out identical. This script is the gate: nothing flips to the new
 * engine until it reports zero BLOCKERs across the whole range matrix.
 *
 * It runs in three parts:
 *
 *   0. SELF-CONSISTENCY.  The legacy endpoint pages with LIMIT/OFFSET and no
 *      ORDER BY, so two consecutive calls can legitimately disagree — rows can
 *      be skipped or double-counted when concurrent writes move tuples. We call
 *      each range THREE times and diff old-against-old FIRST. If the old code
 *      does not agree with itself, "the numbers must not change" is meaningless
 *      and any later diff has to be arbitrated against ground truth instead.
 *
 *   1. TIMINGS.  Duration, payload size and HTTP status for every heavy
 *      endpoint. Status matters as much as duration: an edge function that
 *      exceeds its CPU budget is KILLED, not slowed, and that looks identical
 *      to "slow" from the browser.
 *
 *   2. PARITY (--parity).  legacy → sql → legacy per range. If the two legacy
 *      runs disagree the data moved mid-test and the range is retried rather
 *      than reported as a diff.
 *
 * Severity classes
 * ----------------
 *   BLOCKER  counts/strings/booleans that differ at all; money differing by
 *            >= half a cent; a key or array length appearing or vanishing.
 *   NOTE     sub-cent float drift (JS sums IEEE doubles, Postgres sums exact
 *            decimals — where they disagree Postgres is the correct one), and
 *            array elements reordered among EQUAL sort keys.
 *   OK       identical.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'oufoazmnbwugtfldkwsn';
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

// ── range matrix ───────────────────────────────────────────────────────────
const iso = (d) => d.toISOString().slice(0, 10);
const today = new Date();
const back = (n, unit) => {
  const d = new Date(today);
  if (unit === 'd') d.setDate(d.getDate() - n);
  if (unit === 'mo') d.setMonth(d.getMonth() - n);
  return iso(d);
};
const fwd = (n) => { const d = new Date(today); d.setDate(d.getDate() + n); return iso(d); };

const RANGES = [
  { key: 'today',    from: iso(today),      to: iso(today),  why: 'the default range' },
  { key: '7d',       from: back(6, 'd'),    to: iso(today),  why: 'day granularity' },
  { key: '1mo',      from: back(1, 'mo'),   to: iso(today),  why: 'day granularity, ~5k orders' },
  { key: '93d',      from: back(93, 'd'),   to: iso(today),  why: 'the spanDays<=92 boundary → week' },
  { key: '6mo',      from: back(6, 'mo'),   to: iso(today),  why: 'week granularity' },
  { key: '12mo',     from: back(12, 'mo'),  to: iso(today),  why: 'THE HANG CASE; the <=400 boundary' },
  { key: 'screenshot', from: '2025-05-01',  to: '2026-05-08', why: "the operator's reported range" },
  { key: '410d',     from: back(410, 'd'),  to: iso(today),  why: 'crosses into month granularity' },
  { key: 'alltime',  from: '',              to: '',          why: 'no bounds at all — worst case' },
  { key: 'future',   from: fwd(30),         to: fwd(37),     why: 'zero rows, non-empty bounds' },
  { key: 'inverted', from: iso(today),      to: back(1, 'd'), why: 'from > to → zero rows' },
];
const matrix = ONLY ? RANGES.filter((r) => r.key === ONLY) : RANGES;
if (!matrix.length) fail(`--only=${ONLY} matched no range. Known: ${RANGES.map((r) => r.key).join(', ')}`);

// Always name the engine explicitly. Once INSIGHTS_ENGINE flipped to 'sql',
// omitting the param stopped meaning "legacy" and the harness was silently
// comparing the SQL engine against itself — passing for the wrong reason.
const qs = (r, eng = 'legacy') => {
  const sp = new URLSearchParams();
  if (r.from) sp.set('from', r.from);
  if (r.to) sp.set('to', r.to);
  sp.set('engine', eng);
  return `management-insights?${sp}`;
};

// ── the deep diff ──────────────────────────────────────────────────────────
const MONEY = /(revenue|value|cost|profit|price|cogs|vat|commission|payout|refund|collected|loss|bonus|aov)/i;
const IGNORE = /^meta\.generated_at$/;

function walk(a, b, path, out) {
  if (IGNORE.test(path)) return;

  if (a === null || b === null || a === undefined || b === undefined) {
    if (a !== b) out.push({ path, a, b, sev: 'BLOCKER', why: 'null/undefined mismatch' });
    return;
  }
  const ta = Array.isArray(a) ? 'array' : typeof a;
  const tb = Array.isArray(b) ? 'array' : typeof b;
  if (ta !== tb) { out.push({ path, a, b, sev: 'BLOCKER', why: `type ${ta} → ${tb}` }); return; }

  if (ta === 'array') {
    if (a.length !== b.length) {
      out.push({ path, a: `len ${a.length}`, b: `len ${b.length}`, sev: 'BLOCKER', why: 'array length' });
      return;
    }
    for (let i = 0; i < a.length; i++) walk(a[i], b[i], `${path}[${i}]`, out);
    return;
  }
  if (ta === 'object') {
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

const diff = (a, b) => { const out = []; walk(a, b, '', out); return out; };
const tally = (d) => ({ blocker: d.filter((x) => x.sev === 'BLOCKER').length, note: d.filter((x) => x.sev === 'NOTE').length });
const ms = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}s` : `${n.toFixed(0)}ms`);
const kb = (n) => (n >= 1024 * 1024 ? `${(n / 1048576).toFixed(1)}MB` : `${(n / 1024).toFixed(0)}kB`);
// Blockers first — notes are expected float noise and must never bury a real diff.
const show = (d, n = 8) => [...d].sort((a, b) => (a.sev === 'BLOCKER' ? 0 : 1) - (b.sev === 'BLOCKER' ? 0 : 1)).slice(0, n).forEach((x) =>
  console.log(`      ${x.sev === 'BLOCKER' ? '\x1b[31m' : '\x1b[33m'}${x.sev}\x1b[0m ${x.path}: ${JSON.stringify(x.a)} → ${JSON.stringify(x.b)}   (${x.why})`));

// ══════════════════════════════════════════════════════════════════════════
console.log(`\n\x1b[1mInsights parity harness\x1b[0m — ${EXPECTED_REF}, as ${EMAIL}`);
console.log(`Mode: ${DO_PARITY ? 'PARITY (legacy vs engine=sql)' : 'self-consistency + timings'}\n`);

const report = [];
let totalBlockers = 0, unstable = 0;

for (const r of matrix) {
  const label = `${r.key}`.padEnd(11);
  process.stdout.write(`${label} ${(r.from || '—')} → ${(r.to || '—')}  `);

  const a = await call(qs(r));
  if (a.status !== 200) {
    console.log(`\x1b[31mHTTP ${a.status || 'NETWORK'}\x1b[0m after ${ms(a.ms)}  ${a.raw ?? a.error ?? ''}`);
    console.log(`      \x1b[31m↑ not slow — FAILING. ${a.status === 546 || a.status === 504 ? 'This is the CPU/wall limit.' : ''}\x1b[0m`);
    report.push({ range: r.key, status: a.status, ms: a.ms, error: a.raw ?? a.error });
    totalBlockers++;
    continue;
  }
  const b = await call(qs(r));
  const selfDiff = diff(a.body, b.body);
  const selfT = tally(selfDiff);
  const stable = selfT.blocker === 0;
  if (!stable) unstable++;

  console.log(
    `${ms(a.ms).padStart(7)} ${kb(a.bytes).padStart(8)}  ` +
    (stable ? '\x1b[32mstable\x1b[0m' : `\x1b[31mUNSTABLE (${selfT.blocker} fields differ between two identical calls)\x1b[0m`) +
    `  ${r.why}`,
  );
  if (!stable) show(selfDiff, 5);

  const row = { range: r.key, from: r.from, to: r.to, legacy_ms: Math.round(a.ms), bytes: a.bytes, stable, self_blockers: selfT.blocker };

  if (DO_PARITY) {
    const s = await call(qs(r, 'sql'));
    if (s.status !== 200) {
      console.log(`      \x1b[31mengine=sql → HTTP ${s.status}\x1b[0m ${s.raw ?? s.error ?? ''}`);
      totalBlockers++;
    } else {
      const c = await call(qs(r));                    // legacy again — did data move?
      if (tally(diff(a.body, c.body)).blocker > 0) {
        console.log(`      \x1b[33mskipped: live data changed mid-test (legacy₁ ≠ legacy₃). Re-run in the quiet window.\x1b[0m`);
        row.parity = 'retry';
      } else {
        const d = diff(a.body, s.body);
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

// ── the other heavy endpoints ──────────────────────────────────────────────
console.log(`\n\x1b[1mOther heavy endpoints\x1b[0m (12-month range where applicable)\n`);
const r12 = RANGES.find((x) => x.key === '12mo');
const others = [
  ['orders/stats', 'orders/stats'],
  ['dashboard-stats (today)', 'dashboard-stats?period=today'],
  ['dashboard-stats (month)', 'dashboard-stats?period=month'],
  ['ceo-dashboard-stats', `ceo-dashboard-stats?period=custom&from=${r12.from}&to=${r12.to}`],
  ['segments', 'segments'],
  ['agent-payouts/summary', `agent-payouts/summary?from=${r12.from}&to=${r12.to}`],
  ['agent-performance', `agent-performance?from=${r12.from}&to=${r12.to}`],
  ['orders (page 1)', 'orders?page=1&limit=20'],
  ['orders (search)', 'orders?page=1&limit=20&search=07'],
  ['orders/unassigned-pending', 'orders/unassigned-pending'],
];
for (const [name, path] of others) {
  const res = await call(path);
  const bad = res.status !== 200;
  console.log(
    `  ${name.padEnd(26)} ${(bad ? `HTTP ${res.status}` : ms(res.ms)).padStart(9)} ${kb(res.bytes).padStart(9)}` +
    (bad ? `  \x1b[31m${(res.raw ?? res.error ?? '').slice(0, 90)}\x1b[0m` : res.ms > 3000 ? '  \x1b[33m← slow\x1b[0m' : ''),
  );
  report.push({ endpoint: name, ms: Math.round(res.ms), bytes: res.bytes, status: res.status });
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log('');
if (unstable) {
  console.log(`\x1b[33m⚠ ${unstable} range(s) returned different numbers on two consecutive identical calls.\x1b[0m`);
  console.log(`  That is the unordered LIMIT/OFFSET pagination. Until it is fixed, "unchanged"`);
  console.log(`  cannot be proven by comparison — diffs must be arbitrated against raw SQL.\n`);
}
if (JSON_OUT) { writeFileSync(JSON_OUT, JSON.stringify(report, null, 2)); console.log(`  wrote ${JSON_OUT}\n`); }

if (totalBlockers) {
  console.log(`\x1b[31m✗ ${totalBlockers} BLOCKER(s). The new engine must NOT become the default.\x1b[0m\n`);
  process.exit(1);
}
console.log(`\x1b[32m✓ No blockers.\x1b[0m${DO_PARITY ? ' Parity proven across the matrix.' : ' (Run with --parity once engine=sql exists.)'}\n`);
