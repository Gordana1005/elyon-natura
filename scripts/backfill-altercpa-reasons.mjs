#!/usr/bin/env node
/**
 * Put AlterCPA's cancel/trash reason into the STRUCTURED columns.
 *
 *   node scripts/backfill-altercpa-reasons.mjs            # dry run
 *   node scripts/backfill-altercpa-reasons.mjs --commit
 *
 * The import already wrote the reason into each order's provenance note, which
 * is readable but not queryable — nothing can filter or chart on it. The CRM
 * has proper columns for this, and they are what the cancellation analytics and
 * the Trash List read:
 *
 *   cancelled → orders.cancellation_reason  (+ _notes)
 *   trashed   → orders.trash_reason         (+ _notes)
 *
 * Both are CHECK-constrained, so every AlterCPA code is mapped onto a permitted
 * value here. Where a code has no real equivalent it becomes 'other' and the
 * ORIGINAL AlterCPA wording is preserved in the _notes column, so mapping to a
 * catch-all never loses what actually happened.
 *
 * This is a pure lookup — no inference, no matching. Every value comes straight
 * from the `reason` integer AlterCPA recorded against the order.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readOrders, REASON, isTestOrder, normalizeMkPhone } from './lib/altercpa.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'oufoazmnbwugtfldkwsn';
const SOURCE = 'altercpa';
const COMMIT = process.argv.includes('--commit');

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

// orders_cancellation_reason_check permits: no_money, changed_mind, wrong_product,
// bought_elsewhere, family_refused, duplicate_order, price_too_high, not_satisfied,
// still_using_product, not_interested, will_call_back, other, pending_cleanup,
// stale_pending_cleanup
const CANCEL = {
  2: 'changed_mind',        // 35,494 — the overwhelming majority
  9: 'price_too_high',      //  1,077 "expensive"
  8: 'bought_elsewhere',
  10: 'not_satisfied',      //      6 "unhappy with delivery"
  14: 'wrong_product',      //        "product didn't fit"
  7: 'duplicate_order',
  // Everything else is a network-side disposition with no CRM equivalent
  // (requires certificate, offer disabled, the custom 16-19 codes): 'other',
  // with the original wording kept in cancellation_reason_notes.
};

// orders_trash_reason_check permits: wrong_number, wrong_person, rude,
// uncooperative, other, not_reachable
const TRASH = {
  1: 'wrong_number',        //  4,260 "incorrect phone"
  3: 'wrong_person',        // 13,080 "did not order" — the lead was not theirs
  11: 'not_reachable',      //        "could not reach"
  // duplicate / errors-fakes / wrong geo / fraud / different language → 'other'
};

const orders = readOrders(join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl'));
const rows = [];
const tally = {};
for (const o of orders) {
  if (o.phase !== 4 && o.phase !== 5) continue;
  if (isTestOrder(o) || !normalizeMkPhone(o.phone)) continue;   // never reached the CRM
  const isCancel = o.phase === 4;
  const table = isCancel ? CANCEL : TRASH;
  const raw = Number(o.reason) || 0;
  if (!raw) continue;                                           // no reason recorded
  const value = table[raw] || 'other';
  const label = REASON[raw] ?? `reason ${raw}`;
  const key = `${isCancel ? 'cancel' : 'trash'}:${value}`;
  tally[key] = (tally[key] || 0) + 1;

  // The _notes column is what the Orders page prints next to the reason
  // (src/pages/Orders.tsx:333-344 — trashed renders "label — notes", cancelled
  // renders the notes alone). So it has to carry the OPERATOR'S OWN words, not
  // a restatement of the reason: "Купил веќе" or "бројот не постои" tells you
  // something, "AlterCPA: changed mind" just repeats the chip beside it.
  //
  // Newlines are collapsed because this renders inside a table cell.
  const comment = String(o.comment || '').replace(/\s+/g, ' ').trim();
  let notes = comment;
  if (value === 'other') {
    // Nothing else records what the original disposition was once it has been
    // flattened into the catch-all, so keep it — ahead of the comment. Unless
    // the operator simply typed the reason back at us, which they do often
    // ("враќа нарачки" under the reason meaning exactly that): prefixing then
    // just stutters.
    const same = comment.toLowerCase().startsWith(label.toLowerCase());
    notes = comment ? (same ? comment : `${label} — ${comment}`) : label;
  }
  rows.push({
    id: String(o.id),
    col: isCancel ? 'cancellation_reason' : 'trash_reason',
    notesCol: isCancel ? 'cancellation_reason_notes' : 'trash_reason_notes',
    value,
    // 1000, not 2000: the API's zod schema caps these columns at 1000
    // (supabase/functions/api/index.ts), so a longer value would store fine
    // here and then reject the first time someone edited the order in the UI.
    notes: notes.slice(0, 1000),
    hasComment: !!comment,
  });
}

console.log(`orders with a reason to write: ${rows.length.toLocaleString('en-US')}`);
console.log('\nmapping result:');
for (const [k, n] of Object.entries(tally).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(34)} ${n.toLocaleString('en-US').padStart(7)}`);
}

if (!COMMIT) {
  console.log('\nDRY RUN — nothing written. Re-run with --commit.');
  process.exit(0);
}

// Snapshot first. These columns are all NULL right now, so the rollback is
// "set them back to NULL", but record the scope so it is provable.
const snap = join(ROOT, 'scripts', 'data', `reasons-rollback-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(snap, JSON.stringify({
  note: 'Before backfilling cancellation_reason / trash_reason on the AlterCPA import. All were NULL.',
  external_source: SOURCE, count: rows.length,
}, null, 2));
console.log(`\nrollback note → ${snap}`);

const CHUNK = 2000;
for (const col of ['cancellation_reason', 'trash_reason']) {
  const subset = rows.filter((r) => r.col === col);
  if (!subset.length) continue;
  const notesCol = subset[0].notesCol;
  console.log(`\n${col}: ${subset.length.toLocaleString('en-US')} rows`);
  let done = 0;
  for (let i = 0; i < subset.length; i += CHUNK) {
    const vs = subset.slice(i, i + CHUNK)
      .map((r) => `('${r.id}','${r.value}','${r.notes.replace(/'/g, "''")}')`).join(',');
    // Scope by STATUS as well as id. 2,609 of these orders were cancelled in
    // AlterCPA but proven paid by collabBox, and a paid order must not carry a
    // cancellation reason — the Trash List and the cancellation analytics both
    // read these columns without re-checking status.
    const wantStatus = col === 'cancellation_reason' ? 'cancelled' : 'trashed';
    const out = await sql(`update public.orders o
      set ${col} = v.val, ${notesCol} = nullif(v.notes, '')
      from (values ${vs}) as v(ext, val, notes)
      where o.external_source = '${SOURCE}' and o.external_order_id = v.ext
        and o.status = '${wantStatus}'
      returning 1;`);
    done += out.length;
    process.stdout.write(`\r  updated ${done.toLocaleString('en-US')}   `);
  }
  console.log();
}

console.log('\nresult in the database:');
console.table(await sql(`select status::text, cancellation_reason, trash_reason, count(*)::int n
  from public.orders where external_source='${SOURCE}' and status in ('cancelled','trashed')
  group by 1,2,3 order by 4 desc limit 20;`));
