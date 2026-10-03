#!/usr/bin/env node
/**
 * Recover the order value for imported PAID orders that AlterCPA recorded with
 * no price at all.
 *
 * THE PROBLEM. 1.199 paid orders in the Macedonian book carry price = 0. That is
 * not an import bug — it was verified against every available source:
 *   • the raw AlterCPA export  → all 1.199 present, ZERO with price > 0
 *   • their `items` / `goods`  → 494 have line items; every line is price 0 too
 *   • the CRM's own order_items→ 1.199 rows, none priced
 *   • collabBox               → only 86 overlap, and its amounts are explicitly
 *                                NOT the sale price (handling surcharge + upsells)
 * Two offers account for 95% of it (Alpha Male, Простатол Комплекс): they were
 * evidently configured in AlterCPA without a price for part of their life.
 *
 * WHAT THIS SCRIPT DOES. Where — and only where — the same offer at the same
 * quantity sold at essentially ONE price around the same time, that price is the
 * order's value with high confidence, and is written in. Everything ambiguous is
 * deliberately left at 0.
 *
 * THE BAR (all five must hold):
 *   0. the SOURCE RECORDED A QUANTITY for the order. `price` is the order TOTAL,
 *      so without a real quantity there is nothing to price. AlterCPA writes
 *      count 0 / empty goods when it recorded nothing, and the importer defaults
 *      that to 1 — a display convenience, not evidence. Pricing on top of a
 *      defaulted quantity would stack two guesses, so those are refused outright.
 *      This is what separates the two populations: of the orders recovered, 95%
 *      had a real quantity and only the price was missing; of those refused, 95%
 *      had neither.
 *   1. same AlterCPA offer id
 *   2. same quantity (`price` is the ORDER TOTAL, so pack size must match)
 *   3. ±1 calendar month of the order, using PAID peers only (phase 3)
 *   4. the modal price is ≥90% of those peers, over a sample of ≥10
 *
 * WHAT IT REFUSES. 662 Alpha Male orders (that offer genuinely sold at 1.490,
 * 3.000 AND 4.000 ден — a 2,7× spread, so any single guess is as likely wrong as
 * right) and 20 Veno Gel orders (no priced peer exists at all). Those stay at 0,
 * which is the honest value for "we do not know".
 *
 * THIS CHANGES REVENUE. Reconstructed value is added to a paid book, so profit
 * reports move. Every touched order is stamped in its note with the price, the
 * evidence and this script's name, so the reconstruction is never mistaken for a
 * recorded figure. A full pre-change snapshot is written for rollback.
 *
 * Prices are stored in EUR; AlterCPA records denari. EUR = ден / 61.5, the frozen
 * MKD_PER_EUR from src/lib/currency.ts (verified: 3.000 ден ⇒ €48,78 in the
 * existing import). Never change that constant to "today's rate".
 *
 * Usage:
 *   node scripts/recover-zero-prices-mk.mjs            # plan, writes nothing
 *   node scripts/recover-zero-prices-mk.mjs --commit
 *
 * Run `node scripts/assert-mk-target.mjs` first.
 */
import { readFileSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const MKD_PER_EUR = 61.5;              // must match src/lib/currency.ts
const RAW = join(root, 'scripts', 'data', 'altercpa-mk-raw.jsonl');

const WINDOW_MONTHS = 1;
const MIN_SHARE = 0.90;
const MIN_PEERS = 10;

const commit = process.argv.includes('--commit');

const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF) {
  console.error('config.toml does not point at Macedonia — refusing to run.');
  process.exit(1);
}
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const t = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${t}`);
  return JSON.parse(t);
}

const qlit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const monthOf = (unix) => {
  const d = new Date(unix * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
const shiftMonth = (m, delta) => {
  let [y, mm] = m.split('-').map(Number);
  mm += delta;
  y += Math.floor((mm - 1) / 12);
  mm = ((mm - 1) % 12 + 12) % 12 + 1;
  return `${y}-${String(mm).padStart(2, '0')}`;
};
// AlterCPA writes count 0 for a plain single-unit order.
const qtyOf = (c) => (Number(c) || 0) < 1 ? 1 : Number(c);

// ── the targets, straight from the database ────────────────────────────────
const targetRows = await sql(`
  select external_order_id, id, customer_phone, quantity, product_name
  from public.orders
  where status = 'paid' and coalesce(price, 0) = 0
    and external_source = 'altercpa' and external_order_id is not null`);
const targets = new Map(targetRows.map(r => [String(r.external_order_id), r]));
console.log(`zero-price paid orders: ${targets.size}`);

// ── one pass over the raw export: pick up targets and build the peer index ──
const peers = {};   // "offer|qty" -> month -> { denarPrice: count }
const found = [];
await new Promise((resolve) => {
  const rl = createInterface({ input: createReadStream(RAW) });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch { return; }
    const id = String(o.id);
    const qty = qtyOf(o.count);
    const month = monthOf(o.time);
    const price = Number(o.price) || 0;

    if (targets.has(id)) {
      // Did AlterCPA actually record how many units? count 0 with no goods means
      // "not recorded"; the CRM's quantity=1 for those is the importer's default.
      const qtyRecorded = (Number(o.count) || 0) > 0 || (Array.isArray(o.goods) && o.goods.length > 0);
      found.push({ id, offer: o.offer, offername: o.offername, qty, month, qtyRecorded });
    }
    // Peers are PAID orders only (phase 3) that actually carry a price.
    if (price > 0 && o.phase === 3) {
      const k = `${o.offer}|${qty}`;
      ((peers[k] = peers[k] || {})[month] = peers[k][month] || {})[price] =
        (peers[k][month][price] || 0) + 1;
    }
  });
  rl.on('close', resolve);
});
console.log(`matched in raw export : ${found.length}`);

// ── decide ────────────────────────────────────────────────────────────────
const decided = [];
const refused = {};
for (const t of found) {
  const bucket = peers[`${t.offer}|${t.qty}`];
  const label = t.offername || `offer ${t.offer}`;
  const bump = (why) => { (refused[label] = refused[label] || {})[why] = (refused[label][why] || 0) + 1; };

  if (!t.qtyRecorded) { bump('quantity never recorded either — nothing to price'); continue; }
  if (!bucket) { bump('no priced peer at this quantity'); continue; }

  const tally = {};
  for (let d = -WINDOW_MONTHS; d <= WINDOW_MONTHS; d++) {
    const mm = bucket[shiftMonth(t.month, d)];
    if (!mm) continue;
    for (const [p, c] of Object.entries(mm)) tally[p] = (tally[p] || 0) + c;
  }
  const ranked = Object.entries(tally).sort((a, b) => b[1] - a[1]);
  if (!ranked.length) { bump('no priced peer within ±1 month'); continue; }

  const total = ranked.reduce((s, [, c]) => s + c, 0);
  const share = ranked[0][1] / total;
  if (total < MIN_PEERS) { bump(`too few peers (${total} < ${MIN_PEERS})`); continue; }
  if (share < MIN_SHARE) {
    bump(`price not settled (${ranked.slice(0, 3).map(([p, c]) => `${p}×${c}`).join(' ')})`);
    continue;
  }

  const den = Number(ranked[0][0]);
  const row = targets.get(t.id);
  decided.push({
    ...t,
    orderId: row.id,
    phone: row.customer_phone,
    productName: row.product_name,
    den,
    eur: Math.round((den / MKD_PER_EUR) * 100) / 100,
    share,
    peers: total,
  });
}

// ── report ────────────────────────────────────────────────────────────────
const byOffer = {};
for (const d of decided) {
  const k = d.offername || `offer ${d.offer}`;
  byOffer[k] = byOffer[k] || { n: 0, den: 0, prices: new Set() };
  byOffer[k].n++; byOffer[k].den += d.den; byOffer[k].prices.add(d.den);
}
console.log(`\nRECOVERING ${decided.length} of ${targets.size} orders\n`);
for (const [k, v] of Object.entries(byOffer).sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(4)} orders @ ${[...v.prices].join('/')} ден` +
              `  → €${Math.round(v.den / MKD_PER_EUR).toLocaleString('en-US')}`);
}
const totalEur = decided.reduce((s, d) => s + d.eur, 0);
console.log(`\n  revenue added: €${Math.round(totalEur).toLocaleString('en-US')}` +
            ` (${Math.round(decided.reduce((s, d) => s + d.den, 0)).toLocaleString('en-US')} ден)`);

console.log(`\nLEAVING ${targets.size - decided.length} orders at 0 — evidence too weak:`);
for (const [k, reasons] of Object.entries(refused).sort()) {
  for (const [why, n] of Object.entries(reasons)) {
    console.log(`  ${k.padEnd(34)} ${String(n).padStart(4)}  ${why}`);
  }
}

if (!commit) {
  console.log('\nPLAN ONLY — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}
if (!decided.length) { console.log('\nNothing to do.'); process.exit(0); }

// ── apply ─────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().slice(0, 10);
const snapPath = join(root, 'scripts', 'data', `zero-price-recovery-${stamp}.json`);
writeFileSync(snapPath, JSON.stringify({
  generated: new Date().toISOString(),
  rule: { window_months: WINDOW_MONTHS, min_share: MIN_SHARE, min_peers: MIN_PEERS, mkd_per_eur: MKD_PER_EUR },
  note: 'Every listed order had price=0 before this ran. Restore = set price and order_items back to 0.',
  orders: decided,
}, null, 2), 'utf8');
console.log(`\nSnapshot written: ${snapPath}`);

const CHUNK = 150;
for (let i = 0; i < decided.length; i += CHUNK) {
  const slice = decided.slice(i, i + CHUNK);
  const values = slice.map(d =>
    `(${qlit(d.orderId)}::uuid, ${d.eur}::numeric, ${qlit(
      `[price recovered ${stamp}] AlterCPA recorded no price. Set to ${d.den} ден (€${d.eur.toFixed(2)}) — ` +
      `the price ${Math.round(d.share * 100)}% of ${d.peers} paid ${d.offername} orders at qty ${d.qty} ` +
      `carried within ±1 month. Reconstructed by scripts/recover-zero-prices-mk.mjs, not a recorded figure.`
    )})`).join(',\n      ');

  // One transaction per chunk: the order total, its line items, and an audit
  // note recording that this figure was reconstructed rather than recorded.
  // Guarded on price = 0 throughout, so a re-run can never double-apply.
  await sql(`
    BEGIN;
    CREATE TEMP TABLE _recov(order_id uuid, eur numeric, provenance text) ON COMMIT DROP;
    INSERT INTO _recov(order_id, eur, provenance) VALUES
      ${values};

    UPDATE public.order_items oi
    SET price_per_unit = v.eur / greatest(oi.quantity, 1),
        total_price    = v.eur
    FROM _recov v
    WHERE oi.order_id = v.order_id AND coalesce(oi.price_per_unit, 0) = 0;

    INSERT INTO public.order_notes(order_id, text, author_name)
    SELECT v.order_id, v.provenance, 'System (Price Recovery)'
    FROM _recov v
    JOIN public.orders t ON t.id = v.order_id AND coalesce(t.price, 0) = 0;

    UPDATE public.orders t
    SET price = v.eur
    FROM _recov v
    WHERE t.id = v.order_id AND coalesce(t.price, 0) = 0;
    COMMIT;`);
  console.log(`  applied ${Math.min(i + CHUNK, decided.length)}/${decided.length}`);
}

// Updating orders.price fires trg_orders_segments_status, so memberships and
// trigger_price refresh themselves — but recompute explicitly so the run is
// self-contained and verifiable.
const phones = [...new Set(decided.map(d => d.phone).filter(Boolean))];
console.log(`\nRecomputing segments for ${phones.length} phones…`);
for (let i = 0; i < phones.length; i += 200) {
  const list = phones.slice(i, i + 200).map(qlit).join(',');
  await sql(`do $$ declare p text; begin
    for p in select unnest(array[${list}]) loop
      perform public.recompute_customer_segments(p);
    end loop; end $$;`);
}

const [after] = await sql(`
  select count(*) filter (where status='paid' and coalesce(price,0)=0) as still_zero,
         (select count(*) from public.prediction_segment_members m
            join public.prediction_segment_lists l on l.id = m.list_id
           where l.is_static = false and l.trigger_event = 'last_paid'
             and l.name not like 'Never-%' and coalesce(m.trigger_price,0) = 0) as zero_price_members
  from public.orders`);
console.log(`\nDone. Paid orders still at 0: ${after.still_zero}. Zero-price paid-bucket members: ${after.zero_price_members}.`);
