#!/usr/bin/env node
/**
 * Import collabBox teleshop / social orders into Elyon.
 *
 *   node scripts/import-collabbox-teleshop.mjs <DokumentiStavki.xls> [--apply]
 *
 * WHY THIS EXISTS. collabBox (Accent Collab) is a SECOND order system that runs the
 * teleshop (TV) and social-media business. It never touched Elyon, so roughly 62% of the
 * company's money was invisible to the CRM — only 32,6% of 2026 MEX parcels had an order
 * here. See docs/VAULT.md §7 and the memory entry project_collabbox_channel_series.
 *
 * THREE SOURCES, and why each is needed:
 *   1. Документи-ставки export (this file) — the ONLY place the product (`Артикл`) and
 *      the per-line quantity/value exist. The header-level export has no product column,
 *      and an order without a product is invisible to every product report and to stock.
 *   2. komitenti_full.csv — phone / street address / city, keyed by `Шифра на комитент`.
 *      It is a snapshot, so anyone created after it was taken is missing; MEX covers them.
 *   3. MEX, BOTH accounts — the courier decides paid/returned. A collabBox "Нарачка"
 *      proves DISPATCH, not payment (proven at 2.512-order scale — see the memory entry
 *      project_collabbox_is_dispatch_not_payment). `Број на документ` IS the MEX
 *      `tracking_id`, which is what makes this join exact rather than a guess.
 *
 * IDEMPOTENT. Keyed on (external_source='collabbox', external_order_id=<DocNumber>) —
 * the same pair the 81.657-order history import used, backed by a partial unique index.
 * Re-running skips whatever is already present, so a partial run is safe to resume and
 * overlapping date ranges cannot double-insert.
 *
 * STATUS comes from MEX, never from collabBox:
 *   Delivered        -> paid
 *   Return to sender -> returned
 *   any other parcel -> shipped
 *   no parcel at all -> confirmed   (booked on paper, nothing at the courier yet)
 *
 * CHANNEL is not set here and must not be: order_channel() derives it. A customer's
 * FIRST order becomes 'manual' (teleshop is TV, NOT the affiliate) and every later one
 * becomes 'prediction' — the operator ruling of 2026-09-18.
 */
import { read, utils } from 'xlsx';
import { readFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createClient } from '@supabase/supabase-js';

const MKD_PER_EUR = 61.5;                 // FROZEN — see src/lib/currency.ts
const KOMITENTI = 'C:/Users/Mile/collab_out/komitenti_full.csv';

const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');
if (!FILE) {
  console.error('usage: import-collabbox-teleshop.mjs <DokumentiStavki.xls> [--apply]');
  process.exit(1);
}

// ── guard: Macedonia only, never Bulgaria ───────────────────────────────────
const EXPECTED = 'bmfxhgznttcnnlqloqzp';
const ref = readFileSync('supabase/config.toml', 'utf8').match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED) {
  console.error(`x config.toml project_id = "${ref}", expected "${EXPECTED}"`);
  process.exit(1);
}
const env = { ...process.env };
for (const line of readFileSync('.env', 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
if (!env.VITE_SUPABASE_URL || !env.VITE_SUPABASE_URL.includes(EXPECTED)) {
  console.error('x .env does not point at the MK project');
  process.exit(1);
}
const sb = createClient(env.VITE_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const norm = (s) => String(s ?? '').trim();

/** Local MK number (070…, 70…, 389…) -> E.164, the CRM storage canon. */
function mkE164(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('389')) d = d.slice(3);
  d = d.replace(/^0+/, '');
  if (d.length < 8 || d.length > 9) return null;
  return '+389' + d;
}

// ── 1. line items -> one document per Број на документ ──────────────────────
const wb = read(readFileSync(FILE));
const rows = utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
const hi = rows.findIndex((r) => r.includes('Тип на документ'));
if (hi < 0) {
  console.error('x not a Документи-ставки export (no "Тип на документ" header row)');
  process.exit(1);
}
const H = rows[hi];
const ix = (n) => H.indexOf(n);

const docs = new Map();
for (const r of rows.slice(hi + 1)) {
  const doc = norm(r[ix('Број на документ')]);
  if (!doc) continue;
  const d = String(r[ix('Датум')]);
  const iso = `${d.slice(6, 10)}-${d.slice(3, 5)}-${d.slice(0, 2)}`;
  const o = docs.get(doc) ?? {
    doc,
    tip: norm(r[ix('Тип на документ')]),
    iso,
    kom: norm(r[ix('Шифра на комитент')]),
    komName: norm(r[ix('Комитент')]),
    avtor: norm(r[ix('Aвтор')]),
    items: [],
    mkd: 0,
    qty: 0,
  };
  const art = norm(r[ix('Артикл')]);
  if (art) {
    const q = Number(r[ix('Количина излез')]) || 0;
    const val = Number(r[ix('Продажна вредност со ДДВ')]) || 0;
    o.items.push({ name: art, qty: q, mkd: val });
    o.qty += q;
    o.mkd += val;
  }
  docs.set(doc, o);
}

// ── 2. customers: phone / street / city ─────────────────────────────────────
const splitCsv = (l) => {
  const out = [];
  let cur = '', q = false;
  for (const ch of l) {
    if (ch === '"') { q = !q; continue; }
    if (ch === ',' && !q) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
};
const cust = new Map();
await new Promise((res) => {
  const rl = createInterface({ input: createReadStream(KOMITENTI, { encoding: 'utf8' }), crlfDelay: Infinity });
  let h = null;
  rl.on('line', (l) => {
    if (!h) { h = splitCsv(l.replace(/^\uFEFF/, '')); return; }
    if (!l.trim()) return;
    const r = splitCsv(l);
    const g = (k) => r[h.indexOf(k)] || '';
    cust.set(String(g('Sifra')), { phone: g('Mobilen') || g('Telefon'), name: g('Ime'), addr: g('Adresa'), city: g('Grad') });
  });
  rl.on('close', res);
});

// ── 3. MEX, BOTH accounts — the status truth source ─────────────────────────
const vault = readFileSync('docs/VAULT.md', 'utf8');
const blk = vault.slice(vault.indexOf('**API key**'), vault.indexOf('**API key**') + 400);
const K1 = blk.match(/`([A-Za-z0-9._-]{16,})`/)?.[1];
const K2 = vault.match(/MEX_API_KEY_2[\s\S]{0,400}?`([A-Za-z0-9._/+=-]{20,})`/)?.[1];
const allDates = [...docs.values()].map((o) => o.iso).sort();
const from = new Date(new Date(allDates[0]).getTime() - 3 * 86400000).toISOString().slice(0, 10);

async function mexAll(key) {
  const out = [];
  for (let p = 1; ; p++) {
    const url = `https://mex.mk/api/json/list_shipments.php?updated_from=${from}&per_page=500&page=${p}&order=last_update_asc`;
    const r = await fetch(url, { headers: { AuthKey: key } });
    const j = await r.json();
    if (j?.success !== 1 || !Array.isArray(j.shipments)) break;
    out.push(...j.shipments);
    if (p >= Number(j.total_pages || 1) || out.length >= 60000) break;
  }
  return out;
}
const ship = new Map();
for (const s of [...(K1 ? await mexAll(K1) : []), ...(K2 ? await mexAll(K2) : [])]) ship.set(s.tracking_id, s);

// ── 4. dedupe against what Elyon already has ────────────────────────────────
const present = new Set();
const ids = [...docs.keys()];
for (let i = 0; i < ids.length; i += 400) {
  const { data } = await sb.from('orders').select('external_order_id')
    .eq('external_source', 'collabbox').in('external_order_id', ids.slice(i, i + 400));
  for (const x of data || []) present.add(x.external_order_id);
}

// ── 5. build ────────────────────────────────────────────────────────────────
const STATUS = { Delivered: 'paid', 'Return to sender': 'returned' };
const mexTs = (s) => (s ? new Date(String(s).replace(' ', 'T') + '+02:00').toISOString() : null);

const stats = { create: 0, dup: 0, no_customer: 0, no_phone: 0, no_items: 0, eur: 0, byStatus: {}, errors: 0 };
const toWrite = [];

for (const [doc, o] of docs) {
  if (present.has(doc)) { stats.dup++; continue; }
  if (!o.items.length) { stats.no_items++; continue; }
  const c = cust.get(o.kom);
  const s = ship.get(doc);
  // collabBox first (it carries the street address), MEX as fallback.
  const phone = mkE164(c?.phone) ?? mkE164(s?.receiver_phone);
  if (!phone) { if (!c && !s) stats.no_customer++; else stats.no_phone++; continue; }

  const status = s ? (STATUS[s.current_status_name] ?? 'shipped') : 'confirmed';
  const priceEur = Math.round((o.mkd / MKD_PER_EUR) * 100) / 100;
  const createdAt = new Date(`${o.iso}T09:00:00+02:00`).toISOString();
  const settled = mexTs(s?.last_update_at) ?? createdAt;

  toWrite.push({
    tip: o.tip,
    order: {
      product_name: o.items.map((i) => i.name).join(' + ').slice(0, 300),
      customer_name: (c?.name || s?.receiver_name || o.komName || '—').slice(0, 200),
      customer_phone: phone,
      customer_city: (c?.city || s?.receiver_city || '').slice(0, 120),
      customer_address: (c?.addr || '').slice(0, 600),
      price: priceEur,
      quantity: o.qty || o.items.length,
      status,
      source_type: 'import',
      external_source: 'collabbox',
      external_order_id: doc,
      created_at: createdAt,
      mex_tracking_id: s ? doc : null,
      confirmed_by_name: o.avtor || null,
      confirmed_at: createdAt,
      paid_at: status === 'paid' ? settled : null,
      shipped_at: ['paid', 'returned', 'shipped'].includes(status) ? createdAt : null,
      returned_at: status === 'returned' ? settled : null,
    },
    items: o.items.map((i) => ({
      product_name: i.name.slice(0, 300),
      quantity: i.qty || 1,
      price_per_unit: Math.round((i.mkd / Math.max(1, i.qty) / MKD_PER_EUR) * 100) / 100,
      total_price: Math.round((i.mkd / MKD_PER_EUR) * 100) / 100,
    })),
  });
  stats.create++;
  stats.eur += priceEur;
  stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
}

console.log(`\n=== collabBox teleshop import ${APPLY ? '(APPLYING)' : '(DRY RUN)'} ===`);
console.log(`  file                 : ${FILE}`);
console.log(`  documents in file    : ${docs.size}`);
console.log(`  MEX parcels in scope : ${ship.size}`);
console.log(`  already in Elyon     : ${stats.dup}   (skipped - no duplicates)`);
console.log(`  no customer & no MEX : ${stats.no_customer}`);
console.log(`  no usable phone      : ${stats.no_phone}`);
console.log(`  no line items        : ${stats.no_items}`);
console.log(`  WOULD CREATE         : ${stats.create}   EUR ${stats.eur.toFixed(2)}`);
console.log(`  status split         : ${JSON.stringify(stats.byStatus)}`);

if (!APPLY) {
  console.log('\n(dry run - pass --apply to write)');
  process.exit(0);
}

let done = 0;
for (const w of toWrite) {
  const { data, error } = await sb.from('orders').insert(w.order).select('id').single();
  if (error) {
    if (error.code === '23505') { stats.dup++; continue; }   // concurrent run won
    stats.errors++;
    if (stats.errors <= 5) console.error(`  ! ${w.order.external_order_id}: ${error.message}`);
    continue;
  }
  await sb.from('order_items').insert(w.items.map((i) => ({ order_id: data.id, ...i })));
  await sb.from('order_notes').insert({
    order_id: data.id,
    text: `Imported from collabBox - ${w.tip} ${w.order.external_order_id}\n`
      + `Status from MEX (${w.order.mex_tracking_id ? 'parcel found' : 'no parcel'}): ${w.order.status}`,
    author_id: null,
    author_name: 'System',
  });
  if (++done % 200 === 0) console.log(`  ... ${done}/${toWrite.length}`);
}
console.log(`\nDONE created ${done}   duplicates skipped ${stats.dup}   errors ${stats.errors}`);
