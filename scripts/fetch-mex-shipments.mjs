#!/usr/bin/env node
/**
 * Pull the MEX shipment register to a local cache.
 *
 *   node scripts/fetch-mex-shipments.mjs [--out <file.json>]
 *
 * `updated_from` is REQUIRED to see anything but the trailing 30 days: without
 * it the endpoint returns ~3.400 shipments, with it ~13.100. Any date at or
 * before 2026-04 returns the same total, because that is when MEX started
 * carrying for this account — nothing earlier exists to fetch.
 *
 * The important property of this data is the key: MEX `tracking_id` IS the
 * collabBox document number (`002-9110-158456/2026`). The call centre raises a
 * Нарачка in collabBox and that document number goes on the parcel, so the two
 * systems join exactly — no phone/date/amount guessing anywhere.
 */
import { writeFileSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outIdx = args.indexOf('--out');
const OUT = outIdx >= 0 ? args[outIdx + 1] : join(ROOT, 'scripts', 'data', 'mex-shipments.json');

// Vault §6. Also set as a function secret on the project.
const KEY = process.env.MEX_API_KEY || (() => {
  const vault = readFileSync(join(ROOT, 'docs', 'VAULT.md'), 'utf8');
  return vault.match(/`([0-9a-f]{40})`/)?.[1];
})();
if (!KEY) { console.error('MEX_API_KEY not found (env or VAULT §6).'); process.exit(1); }

const BASE = 'https://mex.mk/api/json';
const PER = 500;
const FROM = '2025-01-01';   // before MEX carried for this account — pulls everything

async function page(n) {
  const url = `${BASE}/list_shipments.php?updated_from=${FROM}&per_page=${PER}&page=${n}&order=last_update_asc`;
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { AuthKey: KEY } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = await res.json();
      if (!j.success) throw new Error(j.response_msg || 'API said failure');
      return j;
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

const first = await page(1);
const total = first.total_count;
const pages = Math.ceil(total / PER);
console.log(`MEX register: ${total.toLocaleString('en-US')} shipments, ${pages} pages of ${PER}`);

const all = new Map();
const add = (list) => { for (const s of list) all.set(s.tracking_id, s); };
add(first.shipments);
for (let p = 2; p <= pages; p++) {
  const j = await page(p);
  add(j.shipments);
  if (p % 5 === 0 || p === pages) console.log(`  page ${p}/${pages} — ${all.size.toLocaleString('en-US')} unique`);
}

const rows = [...all.values()];
const st = {};
for (const s of rows) st[`${s.current_status_id} ${s.current_status_name}`] = (st[`${s.current_status_id} ${s.current_status_name}`] || 0) + 1;
const dates = rows.map((s) => s.created_at).filter(Boolean).sort();
console.log(`\nunique shipments ${rows.length.toLocaleString('en-US')}`);
console.log(`created range    ${dates[0]} … ${dates[dates.length - 1]}`);
console.log('status mix:');
for (const [k, n] of Object.entries(st).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(28)} ${String(n).padStart(6)}  ${((100 * n) / rows.length).toFixed(1)}%`);

writeFileSync(OUT, JSON.stringify(rows), 'utf8');
console.log(`\n→ ${OUT}`);
