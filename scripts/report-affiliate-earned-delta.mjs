#!/usr/bin/env node
/**
 * READ-ONLY: what the earned-at-confirmation flip is worth, per affiliate.
 *
 *   node scripts/report-affiliate-earned-delta.mjs
 *
 * Why this exists: on 2026-08-10 the operator moved affiliate payout from the
 * COD gate (`orders.status='paid'`) to the FIRST confirmation, sticky forever —
 * a later cancel / trash / return never takes it back. That re-prices every
 * lead in the ledger at once, so before shipping it somebody has to be able to
 * answer "how much more do we owe?" in one number. In Bulgaria the flip was
 * +€420. In Macedonia the affiliate program has no data yet, so this prints
 * zeros — run it anyway: it is the standing tool for this feature, and the
 * moment the first partner signs it becomes the sign-off report.
 *
 * Columns:
 *   leads             every affiliate_lead in the ledger
 *   old hold  cnt/EUR the pre-flip "Approved (hold)" pool (confirmed|shipped|delivered)
 *   old earned EUR    what was actually payable before the flip (paid only)
 *   new pure  cnt/EUR earned by the timestamp alone (confirmed_at IS NOT NULL)
 *   new defen cnt/EUR earned incl. the defensive OR (status in REAL_ORDER_STATUSES)
 *   DELTA EUR         new defensive − old earned  ← the money question
 *   retro             stamped AND now cancelled/trashed/returned (paid for a
 *                     lead we no longer earn on — the sticky rule in action)
 *   hold→earn         leads that were "on hold" and are now simply earned
 *   gap               status in REAL but confirmed_at NULL — the rows that
 *                     justify keeping the defensive OR. Should be 0.
 *
 * Issues only SELECTs. Refuses to run unless supabase/config.toml points at the
 * Macedonian ref (never Bulgaria).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };
const ok = (m) => console.log(`\x1b[32m✓\x1b[0m ${m}`);

// Guard: never let this run against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = { ...process.env };
try {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* .env optional when the vars are already exported */ }

const url = env.VITE_SUPABASE_URL;
const key = env.SUPABASE_SERVICE_ROLE_KEY;
if (!url) fail('VITE_SUPABASE_URL missing');
if (!key) fail('SUPABASE_SERVICE_ROLE_KEY missing');
if (!url.includes(EXPECTED_REF)) fail(`VITE_SUPABASE_URL points at ${url}, expected ${EXPECTED_REF}`);

const supabase = createClient(url, key, { auth: { persistSession: false } });

// Mirror of REAL_ORDER_STATUSES in supabase/functions/api/index.ts and of the
// pre-flip CPA_STAGE buckets. Keep the three in sync.
const REAL_ORDER_STATUSES = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];
const OLD_HOLD_STATUSES = ['confirmed', 'shipped', 'delivered'];

// Supabase caps each query at 1k rows — page or the report silently under-counts.
async function paginate(makeQuery, pageSize = 1000) {
  const all = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await makeQuery().range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all.push(...data);
    if (data.length < pageSize) break;
  }
  return all;
}

const round2 = (n) => Math.round(n * 100) / 100;

const [affiliates, leads] = await Promise.all([
  paginate(() => supabase.from('affiliates').select('id, code, name')),
  paginate(() => supabase
    .from('affiliate_leads')
    .select('affiliate_id, payout_eur_snapshot, orders(status, confirmed_at)')),
]);

const nameById = new Map(affiliates.map((a) => [a.id, `${a.name} (${a.code})`]));

const blank = () => ({
  leads: 0,
  oldHoldCnt: 0, oldHoldEur: 0,
  oldEarnedEur: 0,
  newPureCnt: 0, newPureEur: 0,
  newDefCnt: 0, newDefEur: 0,
  retroCnt: 0, retroEur: 0,
  holdToEarned: 0,
  gapRows: 0,
});

const byAff = new Map();
const TOTAL = blank();

for (const l of leads) {
  const o = l.orders;
  const p = Number(l.payout_eur_snapshot) || 0;
  const status = o?.status || '';
  const stamped = o?.confirmed_at != null;
  const inReal = REAL_ORDER_STATUSES.includes(status);

  if (!byAff.has(l.affiliate_id)) byAff.set(l.affiliate_id, blank());
  for (const r of [byAff.get(l.affiliate_id), TOTAL]) {
    r.leads++;
    if (OLD_HOLD_STATUSES.includes(status)) { r.oldHoldCnt++; r.oldHoldEur += p; }
    if (status === 'paid') r.oldEarnedEur += p;
    if (stamped) { r.newPureCnt++; r.newPureEur += p; }
    if (stamped || inReal) { r.newDefCnt++; r.newDefEur += p; }
    // Sticky in action: confirmed once, killed later — we still owe it.
    if (stamped && ['cancelled', 'trashed', 'returned'].includes(status)) { r.retroCnt++; r.retroEur += p; }
    if (OLD_HOLD_STATUSES.includes(status) && (stamped || inReal)) r.holdToEarned++;
    // The rows the defensive OR exists for. Expected: 0.
    if (inReal && !stamped) r.gapRows++;
  }
}

const row = (label, r) => ({
  affiliate: label,
  leads: r.leads,
  'old hold cnt': r.oldHoldCnt,
  'old hold €': round2(r.oldHoldEur),
  'old earned €': round2(r.oldEarnedEur),
  'new pure cnt': r.newPureCnt,
  'new pure €': round2(r.newPureEur),
  'new defensive cnt': r.newDefCnt,
  'new defensive €': round2(r.newDefEur),
  'DELTA €': round2(r.newDefEur - r.oldEarnedEur),
  'retro cnt': r.retroCnt,
  'retro €': round2(r.retroEur),
  'hold→earned': r.holdToEarned,
  gap: r.gapRows,
});

const table = [...byAff.entries()]
  .map(([id, r]) => row(nameById.get(id) || id, r))
  .sort((a, b) => b['DELTA €'] - a['DELTA €']);
table.push(row('— TOTAL —', TOTAL));

console.log(`\nAffiliate payout: earned-at-confirmation delta — ${EXPECTED_REF}\n`);
console.table(table);

console.log(`\nAffiliates: ${affiliates.length} · leads: ${leads.length}`);
console.log(`Extra owed by the flip: \x1b[1m€${round2(TOTAL.newDefEur - TOTAL.oldEarnedEur)}\x1b[0m`);

if (TOTAL.gapRows > 0) {
  console.warn(
    `\n\x1b[33m⚠ ${TOTAL.gapRows} lead(s) sit in a real status with confirmed_at NULL.\x1b[0m\n` +
    '  The defensive OR in affiliateEarned() is what pays them. Do not remove it.',
  );
} else {
  ok('No gap rows — every real-status order carries its confirmed_at stamp.');
}
if (leads.length === 0) {
  ok('No affiliate leads yet: the flip costs €0. Ship it before the first partner signs.');
}
