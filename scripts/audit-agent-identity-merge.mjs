#!/usr/bin/env node
/**
 * audit-agent-identity-merge.mjs — what the cross-script operator fold merges.
 *
 * Attribution in /api/agent-performance keys on `agentIdentityKey()`: a
 * script-folded operator name, so one human spelled three ways ("Sashka
 * Simonovska" the account, "Saska Simonovska" and "Сашка Симоновска" in the
 * imported history) is ONE owner instead of three.
 *
 * That fold decides who a paid order — and therefore its commission basis —
 * belongs to. Run this before changing AGENT_CYR_TO_LAT / AGENT_LATIN_DIGRAPHS
 * in supabase/functions/api/index.ts, and read the output: every group printed
 * here is a claim that those spellings are the same person.
 *
 * Read-only. Touches Macedonia only.
 *
 *   node --env-file=.env scripts/audit-agent-identity-merge.mjs
 */
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.VITE_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

// ── MUST stay identical to agentIdentityKey() in supabase/functions/api/index.ts ──
const AGENT_CYR_TO_LAT = {
  'а':'a','б':'b','в':'v','г':'g','д':'d','ѓ':'g','е':'e','ж':'z','з':'z',
  'ѕ':'d','и':'i','ј':'j','к':'k','л':'l','љ':'l','м':'m','н':'n','њ':'n',
  'о':'o','п':'p','р':'r','с':'s','т':'t','ќ':'k','у':'u','ф':'f','х':'h',
  'ц':'c','ч':'c','џ':'d','ш':'s',
  'й':'j','щ':'st','ъ':'a','ь':'j','ю':'u','я':'a','ы':'i','э':'e','ё':'e',
  'ђ':'d','ћ':'c','ѐ':'e','ѝ':'i',
};
const AGENT_LATIN_DIGRAPHS = [
  ['dzh','d'], ['zh','z'], ['sh','s'], ['ch','c'], ['dz','d'],
  ['gj','g'], ['kj','k'], ['lj','l'], ['nj','n'], ['ts','c'],
];

function normAgentName(raw) {
  let n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'Unknown operator';
  n = n.replace(/\s+\p{L}\.?$/u, '').trim();
  return n || 'Unknown operator';
}

function agentIdentityKey(raw) {
  const n = normAgentName(raw);
  if (n === 'Unknown operator') return '';
  let out = n.toLowerCase().split('').map(c => AGENT_CYR_TO_LAT[c] ?? c).join('');
  out = out.normalize('NFD').replace(/[̀-ͯ]/g, '');
  out = out.replace(/ç/g, 'c').replace(/đ/g, 'd').replace(/ø/g, 'o');
  for (const [from, to] of AGENT_LATIN_DIGRAPHS) out = out.split(from).join(to);
  return out.replace(/[^a-z]+/g, ' ').trim();
}

// Pairs the operator has ruled on (2026-08-14). A fold that merges any of these
// is a REGRESSION — different people, same given name.
const MUST_STAY_APART = [
  ['Teodora Kostovska', 'Teodora Krstevska'],
  ['Zhaklina Bogatinova', 'Zaklina Denik'],
];

const { data: profiles } = await supabase
  .from('profiles').select('user_id, full_name').eq('is_active', true);
const { data: ops, error } = await supabase.rpc('order_operator_names');
if (error) { console.error('order_operator_names failed:', error.message); process.exit(1); }

const groups = {};
for (const p of profiles || []) {
  const k = agentIdentityKey(p.full_name);
  if (!k) continue;
  (groups[k] ??= { accounts: [], historic: {}, orders: 0 }).accounts.push(p.full_name);
}
for (const r of ops || []) {
  const k = agentIdentityKey(r.operator_name);
  if (!k) continue;
  const g = (groups[k] ??= { accounts: [], historic: {}, orders: 0 });
  const label = normAgentName(r.operator_name);
  g.historic[label] = (g.historic[label] || 0) + Number(r.order_count);
  g.orders += Number(r.order_count);
}

const merged = Object.entries(groups)
  .filter(([, g]) => g.accounts.length + Object.keys(g.historic).length > 1)
  .sort((a, b) => b[1].orders - a[1].orders);

console.log('=== MERGED BY THE FOLD — each block is "these are one person" ===\n');
let people = 0, ordersMoved = 0;
for (const [key, g] of merged) {
  people++;
  ordersMoved += g.orders;
  const dest = g.accounts.length ? `account "${g.accounts[0]}"` : 'a single historic identity';
  console.log(`  ${key}  →  ${dest}   (${g.orders} orders)`);
  for (const a of g.accounts) console.log(`      account   "${a}"`);
  for (const [h, n] of Object.entries(g.historic).sort((a, b) => b[1] - a[1])) {
    console.log(`      historic  "${h}"  ${n}`);
  }
  if (g.accounts.length > 1) console.log(`      ⚠ TWO ACCOUNTS fold together — the report will show the first.`);
  console.log('');
}
console.log(`${people} identities merged; ${ordersMoved} orders now grouped under a single owner.\n`);

console.log('=== OPERATOR RULINGS — these must NOT merge ===');
let regressions = 0;
for (const [a, b] of MUST_STAY_APART) {
  const same = agentIdentityKey(a) === agentIdentityKey(b);
  if (same) regressions++;
  console.log(`  ${same ? '✗ REGRESSION' : '✓ apart'}   "${a}"  vs  "${b}"`);
}

// Names the fold left alone that a human might still consider the same person.
// Reported, never merged — a shared given name is not evidence.
console.log('\n=== LEFT APART — same given name, different surname (needs a human) ===');
const byFirst = {};
for (const [key, g] of Object.entries(groups)) {
  const first = key.split(' ')[0];
  const label = g.accounts[0] || Object.keys(g.historic)[0];
  (byFirst[first] ??= []).push({ key, label, orders: g.orders, isAccount: g.accounts.length > 0 });
}
for (const [first, list] of Object.entries(byFirst)) {
  if (list.length < 2) continue;
  console.log(`  ${first}:`);
  for (const x of list.sort((a, b) => b.orders - a.orders)) {
    console.log(`      ${x.isAccount ? '[account] ' : '[historic]'} "${x.label}"  ${x.orders} orders`);
  }
}

process.exit(regressions > 0 ? 1 : 0);
