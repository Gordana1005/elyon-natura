#!/usr/bin/env node
/**
 * ⚠️ SUPERSEDED — THE PREMISE BELOW IS WRONG. DO NOT RE-RUN WITH --apply.
 *
 * "every row in these two exports is a PAID order" is refuted by the full
 * register (2026-08-12). A collabBox "Нарачка" is an ORDER/DISPATCH note, not
 * an invoice: measured against the population, `returned` (×1,83) and `shipped`
 * (×1,96) are enriched MORE than `paid` (×1,58), while never-dispatched
 * statuses are depleted (trashed ×0,25, pending ×0,09). A return is money never
 * collected, so a payment document could not over-represent returns.
 *
 * This script wrote 2.621 orders straight to `paid` on that premise; 2.512 are
 * still live that way, and 97 have since been proven RETURNED by MEX's own
 * terminal status. See scripts/audit-collabbox-paid.mjs, which uses the
 * re-export (phone + product) and reports dispatch outcome without flipping
 * anything.
 *
 * ── original header ──
 * collabBox is the fixer for AlterCPA.
 *
 * AlterCPA's own `paid` field is 0 on every one of the 81,657 MK orders, so the
 * furthest it goes is "approved". collabBox holds the documents the call centre
 * actually raised — every row in these two exports is a PAID order. Where
 * collabBox says paid and AlterCPA says cancelled, collabBox wins.
 *
 *   node scripts/match-collabbox.mjs            # match + report, writes nothing
 *   node scripts/match-collabbox.mjs --apply    # write the corrections file
 *
 * The corrections file is consumed by import-altercpa-mk.mjs, so the CRM is
 * written once, already correct — rather than importing 81k rows and then
 * PATCHing thousands of them through the segment-recompute trigger.
 *
 * ── The join ──
 * The collabBox export carries no phone and no product: only a document number,
 * "#code Name", an amount in denars, a timestamp and the operator. So the only
 * available key is NAME + DATE. That is weak, and the tiering below is about
 * not pretending otherwise — an ambiguous match is reported, never guessed.
 *
 * ── Why the window is 5 days ──
 * Swept over the Apr-Dec 2025 slice. "Enrichment" = how much more often a match
 * lands on an already-approved AlterCPA order than the 30.8% population base
 * rate; it is the precision signal, because a correct match should usually find
 * an order the call centre also approved.
 *
 *     window   unique   ambiguous   approved%   enrichment   flips
 *      -1d      1,861      158        52.1%       x1.69       828
 *      -3d      2,026      255        51.0%       x1.65       895
 *      -5d      2,093      357        50.4%       x1.64       915
 *      -8d      2,172      504        50.4%       x1.64       917
 *
 * Precision barely moves out to 5 days while yield keeps climbing; at 8 days the
 * flips stop growing (915 → 917) and ambiguity jumps 40%. -5d is the knee. The
 * +1d side absorbs the UTC boundary — collabBox stamps a local date, AlterCPA a
 * UTC epoch.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import {
  PHASE, readOrders, productNameOf, isoDay,
  nameKey, nameTokens, editDistance, toEur,
} from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl');
const OUT_JSON = join(ROOT, 'scripts', 'data', 'collabbox-corrections.json');
const OUT_CSV = join(ROOT, 'scripts', 'data', 'collabbox-corrections.csv');
const OUT_MD = join(ROOT, 'scripts', 'data', 'collabbox-corrections.md');
const APPLY = process.argv.includes('--apply');

const DAYS_BACK = 5;
const DAYS_FWD = 1;

/**
 * collabBox amounts are NOT the AlterCPA price — the call centre adds a
 * handling surcharge and sometimes upsells. Measured over the matched pairs,
 * the difference clusters hard on a few values:
 *
 *     +150 den x1203   0 den x356   -150 den x126   +100 den x85
 *     +155 den  x57   +105 den x49    …then a long tail of real upsells
 *      (+1510, +1605, +1300 … the customer bought more on the call)
 *
 * So a small difference CORROBORATES a match, while a large one means nothing
 * either way — it is just as likely an upsell. That asymmetry is why the
 * amount is used only to confirm weak name evidence, never to choose between
 * competing candidates.
 */
const SURCHARGE_MAX = 155;

const FILES = [
  { path: join(ROOT, 'LeadIn - Pending orders.xls'), source: 'LeadIn', note: 'paid first orders from affiliate leads' },
  { path: join(ROOT, 'LeadOut - Predikcii.xls'), source: 'LeadOut', note: 'paid repeat orders from prediction lists' },
];

// ── read the collabBox registers ──────────────────────────────────────────
// Row 0 is the report title, row 1 the real header. Only 8 of the 38 columns
// are ever populated; the rest are empty report scaffolding.
const COL = { doc: 1, type: 2, party: 3, amount: 5, currency: 6, datetime: 8, author: 9 };

function readRegister({ path, source }) {
  // XLSX.readFile is unavailable in the ESM build (fs is stripped) — read the
  // bytes ourselves, same as scripts/import-cpa-xlsx.mjs does.
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', raw: false });
  const out = [];
  for (const r of aoa.slice(2)) {
    const doc = String(r[COL.doc] ?? '').trim();
    if (!doc) continue;
    const dm = String(r[COL.datetime] ?? '').match(/^(\d{2})\.(\d{2})\.(\d{4})/);
    if (!dm) continue;
    const party = String(r[COL.party] ?? '').trim();
    const pm = party.match(/^#(\d+)\s*(.*)$/);
    out.push({
      source,
      doc,
      code: pm ? pm[1] : '',
      name: pm ? pm[2].trim() : party,
      amount: Number(r[COL.amount]) || 0,
      currency: String(r[COL.currency] ?? '').trim(),
      date: `${dm[3]}-${dm[2]}-${dm[1]}`,
      day: Math.floor(Date.UTC(+dm[3], +dm[2] - 1, +dm[1]) / 86400000),
      author: String(r[COL.author] ?? '').trim(),
    });
  }
  return out;
}

const docs = FILES.flatMap(readRegister);
console.log(`collabBox documents: ${docs.length.toLocaleString('en-US')}`);
for (const f of FILES) {
  console.log(`  ${f.source.padEnd(8)} ${docs.filter((d) => d.source === f.source).length.toLocaleString('en-US')}  (${f.note})`);
}

// ── index AlterCPA by day ─────────────────────────────────────────────────
const orders = readOrders(RAW);
const byDay = new Map();
for (const o of orders) {
  const d = Math.floor(o.time / 86400);
  if (!byDay.has(d)) byDay.set(d, []);
  byDay.get(d).push(o);
}
console.log(`AlterCPA MK orders:   ${orders.length.toLocaleString('en-US')}`);

// ── match ─────────────────────────────────────────────────────────────────
// Deterministic order (oldest first), and an AlterCPA order can only ever be
// claimed by one collabBox document — otherwise two same-name documents days
// apart would both flip the same order and the count would lie.
docs.sort((a, b) => (a.day - b.day) || a.doc.localeCompare(b.doc));

const claimed = new Set();
const results = [];
const stat = { A: 0, B: 0, weak: 0, ambiguous: 0, none: 0, already_paid: 0, flips: 0 };

const corroborates = (doc, order) => {
  const p = Number(order.price) || 0;
  return p > 0 && doc.amount > 0 && Math.abs(doc.amount - p) <= SURCHARGE_MAX;
};

for (const d of docs) {
  const tokens = nameTokens(d.name);
  if (!tokens.length) { stat.none++; results.push({ ...d, tier: 'none', why: 'unusable name' }); continue; }
  const k = tokens.slice().sort().join(' ');
  // Operators type "ЗОРАН ЗОРАН" and "МИЛАН - МИЛАН" when they only ever got a
  // first name. Two tokens, one name — count DISTINCT tokens so those are
  // treated as the weak evidence they are.
  const distinct = new Set(tokens).size;

  let pool = [];
  for (let off = -DAYS_BACK; off <= DAYS_FWD; off++) pool = pool.concat(byDay.get(d.day + off) || []);
  pool = pool.filter((o) => !claimed.has(o.id));

  let tier = null;
  let cands = pool.filter((o) => nameKey(o.name) === k);
  if (cands.length) tier = 'A';
  else {
    // Fuzzy: every collabBox token needs a near-twin in the AlterCPA name AND
    // at least one token must match exactly. Without that second clause,
    // distance-1 on both halves pairs "Иле Петровски" with "Миле Петковски" —
    // two different people. Requiring one anchor keeps the real cases
    // (Идризовски/Идризоски, Вељанова/Вењанова, Тошанова/Тошанпва) because
    // those all share an untouched first name.
    cands = pool.filter((o) => {
      const ot = nameTokens(o.name);
      if (new Set(ot).size < 2 || distinct < 2) return false;
      if (!tokens.every((a) => ot.some((b) => editDistance(a, b) <= 1))) return false;
      return tokens.some((a) => ot.includes(a));
    });
    if (cands.length) tier = 'B';
  }

  if (!cands.length) { stat.none++; results.push({ ...d, tier: 'none', why: 'no candidate in window' }); continue; }

  // Several candidates and nothing to separate them. The amount cannot break
  // the tie — collabBox's surcharge means a "close" amount is evidence about
  // whether a pair is right, not about which of two people it is.
  if (cands.length > 1) {
    stat.ambiguous++;
    results.push({ ...d, tier: 'ambiguous', why: `${cands.length} candidates in window`, candidates: cands.map((o) => o.id) });
    continue;
  }
  const pick = cands[0];

  // A lone first name ("Гоце", "Живко") is the weakest evidence there is —
  // one common name in a day that saw ~250 orders. Accept it only when the
  // amount independently corroborates; otherwise report it and move on.
  if (distinct < 2 && !corroborates(d, pick)) {
    stat.weak++;
    results.push({ ...d, tier: 'weak', why: 'single-token name, amount does not corroborate', candidates: [pick.id] });
    continue;
  }

  claimed.add(pick.id);
  stat[tier]++;
  const willFlip = pick.phase === 4 || pick.phase === 5;
  if (pick.phase === 3) stat.already_paid++;
  if (willFlip) stat.flips++;
  results.push({
    ...d, tier, why: willFlip ? 'flip → paid' : `already ${PHASE[pick.phase]}`,
    order: {
      id: pick.id, name: pick.name, phone: pick.phone, date: isoDay(pick.time),
      price: pick.price, currency: pick.currency, phase: PHASE[pick.phase],
      product: productNameOf(pick),
    },
    flip: willFlip,
  });
}

// ── precision check ───────────────────────────────────────────────────────
const matched = results.filter((r) => r.order);
const baseApproved = orders.filter((o) => o.phase === 3).length / orders.length;
const gotApproved = matched.filter((r) => r.order.phase === 'approved').length / (matched.length || 1);

console.log(`\nmatched   ${matched.length.toLocaleString('en-US')}  (A ${stat.A.toLocaleString('en-US')} · B ${stat.B.toLocaleString('en-US')})`);
console.log(`ambiguous ${stat.ambiguous.toLocaleString('en-US')}  (reported, never guessed)`);
console.log(`weak      ${stat.weak.toLocaleString('en-US')}  (single-token name, uncorroborated — reported, not applied)`);
console.log(`no match  ${stat.none.toLocaleString('en-US')}`);
console.log(`\nprecision: ${(100 * gotApproved).toFixed(1)}% of matches landed on an already-approved order`);
console.log(`           vs a ${(100 * baseApproved).toFixed(1)}% base rate — enrichment x${(gotApproved / baseApproved).toFixed(2)}`);
console.log(`\nFLIPS to paid: ${stat.flips.toLocaleString('en-US')}`);

// ── outputs ───────────────────────────────────────────────────────────────
const csv = ['sep=;', [
  'tier', 'outcome', 'collabbox_source', 'collabbox_doc', 'collabbox_code', 'collabbox_name',
  'collabbox_date', 'collabbox_amount_mkd', 'collabbox_author',
  'altercpa_id', 'altercpa_name', 'altercpa_phone', 'altercpa_date', 'altercpa_price',
  'altercpa_currency', 'altercpa_phase', 'altercpa_product', 'lag_days',
].join(';')];
for (const r of results) {
  const o = r.order;
  csv.push([
    r.tier, r.why, r.source, r.doc, r.code, r.name, r.date, r.amount, r.author,
    o?.id ?? '', o?.name ?? '', o?.phone ?? '', o?.date ?? '', o?.price ?? '',
    o?.currency ?? '', o?.phase ?? '', o?.product ?? '',
    o ? Math.round((Date.parse(r.date) - Date.parse(o.date)) / 86400000) : '',
  ].map((v) => String(v ?? '').replace(/[;\r\n]/g, ' ')).join(';'));
}
writeFileSync(OUT_CSV, '﻿' + csv.join('\n'), 'utf8');

const flips = results.filter((r) => r.flip);
const corrections = {
  _comment: 'AlterCPA order id -> forced Elyon status, proven by a collabBox document. Consumed by import-altercpa-mk.mjs. Regenerate with: node scripts/match-collabbox.mjs --apply',
  generated: new Date().toISOString(),
  window: { days_back: DAYS_BACK, days_forward: DAYS_FWD },
  counts: { ...stat, matched: matched.length, documents: docs.length },
  precision: { matched_approved_share: Number(gotApproved.toFixed(4)), population_share: Number(baseApproved.toFixed(4)) },
  orders: Object.fromEntries(flips.map((r) => [r.order.id, {
    status: 'paid',
    tier: r.tier,
    doc: r.doc,
    source: r.source,
    was: r.order.phase,
  }])),
};

const L = [];
const say = (s = '') => L.push(s);
say(`# collabBox corrections`);
say();
say(`${docs.length.toLocaleString('en-US')} collabBox documents matched against ${orders.length.toLocaleString('en-US')} AlterCPA MK orders.`);
say(`Window: AlterCPA date within \`[collabBox date − ${DAYS_BACK}d, collabBox date + ${DAYS_FWD}d]\`.`);
say();
say(`| | documents | share |`);
say(`|---|---:|---:|`);
for (const [k, label] of [
  ['A', 'tier A — exact name, one candidate'],
  ['B', 'tier B — fuzzy name (one token exact), one candidate'],
  ['weak', 'weak — single-token name, amount did not corroborate → not applied'],
  ['ambiguous', 'ambiguous — several candidates → not applied'],
  ['none', 'no candidate in window'],
]) {
  say(`| ${label} | ${stat[k].toLocaleString('en-US')} | ${((100 * stat[k]) / docs.length).toFixed(1)}% |`);
}
say();
say(`**${stat.flips.toLocaleString('en-US')} orders flip from cancelled/trash to paid.**`);
say(`${stat.already_paid.toLocaleString('en-US')} matched orders were already approved — no change, but they are the`);
say(`evidence the matcher works: ${(100 * gotApproved).toFixed(1)}% of matches landed on an approved order against a`);
say(`${(100 * baseApproved).toFixed(1)}% base rate (enrichment ×${(gotApproved / baseApproved).toFixed(2)}). A matcher pairing people at random would show ×1.00.`);
say();
say(`## What this does not reach`);
say();
const unmatchedByS = {};
for (const r of results) if (!r.order) unmatchedByS[r.source] = (unmatchedByS[r.source] || 0) + 1;
for (const [s, n] of Object.entries(unmatchedByS)) {
  say(`- **${s}** — ${n.toLocaleString('en-US')} documents found no AlterCPA counterpart.`);
}
say();
say(`collabBox records ${docs.length.toLocaleString('en-US')} paid orders; AlterCPA approves ${orders.filter((o) => o.phase === 3).length.toLocaleString('en-US')}, and this pass`);
say(`recovers ${stat.flips.toLocaleString('en-US')} more. The remainder cannot be imported at all — the collabBox export`);
say(`carries no phone and no product, and phone is the CRM's only customer identity.`);
say(`Fixing that needs a collabBox re-export with those two columns.`);
say();
say(`Full row-by-row audit: \`scripts/data/collabbox-corrections.csv\` (semicolon-separated, UTF-8 BOM).`);
say();
writeFileSync(OUT_MD, L.join('\n'), 'utf8');

if (APPLY) {
  writeFileSync(OUT_JSON, JSON.stringify(corrections, null, 2), 'utf8');
  console.log(`\n✓ wrote ${OUT_JSON} (${Object.keys(corrections.orders).length.toLocaleString('en-US')} corrections)`);
} else {
  console.log(`\nDRY RUN — corrections file not written. Re-run with --apply.`);
}
console.log(`  audit  ${OUT_CSV}`);
console.log(`  report ${OUT_MD}`);
