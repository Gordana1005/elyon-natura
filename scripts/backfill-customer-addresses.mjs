#!/usr/bin/env node
/**
 * Fill customer_profiles' structured address fields from each customer's most
 * recent address-bearing order — FILL-ONLY, with one deliberate exception.
 *
 *   node scripts/backfill-customer-addresses.mjs            # dry run (default)
 *   node scripts/backfill-customer-addresses.mjs --commit
 *
 * Why: the AlterCPA history import wrote the packed address blob into
 * orders.customer_address (10.297 of 81.247 orders carry one) and — via the
 * non-fill-only upsert in POST /api/orders/import — shoved that same blob into
 * customer_profiles.street. The live ledger's structured street field is empty
 * across the board (measured 2026-08-11: 0 of 2.270), so ORDERS are the source
 * here, not altercpa_leads.
 *
 * Rules:
 *   - An agent-entered profile value is NEVER overwritten (fill-only) — the
 *     agent on the phone had better data than any import.
 *   - EXCEPTION: a profile whose `street` is byte-identical to one of that
 *     customer's order blobs is machine-written, not agent-entered, and is
 *     safe to re-parse into the structured fields.
 *   - mex_city_id/mex_city_name are resolved via mk_settlements the same way
 *     scripts/backfill-order-mex-city.mjs does, only when currently empty.
 *   - No orders/status writes → no segment-trigger handling needed.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { normalizeMkGeo } from './lib/mk-translit.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';                       // MACEDONIA. never change.
const COMMIT = process.argv.includes('--commit');

const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*?)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* .env optional when real env vars are set */ }

const SUPABASE_URL = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
const SERVICE_KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(1);
}
if (!SUPABASE_URL.includes(REF)) {
  console.error(`SUPABASE_URL points at ${SUPABASE_URL}, not Macedonia (${REF}). Refusing to run.`);
  process.exit(1);
}
const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

/* ── parser — PORT of parseHomeAddress in src/lib/address.ts; keep in step ── */

const cleanAddr = (s) =>
  (s || '').replace(/[«»"„""]/g, '').replace(/\s+/g, ' ').replace(/^[\s,;.-]+|[\s,;.-]+$/g, '').trim();
const looksLikeCourier = (t) => !!t && /(еконт|econt|спиди|speedy|мекс|mex|офис|автомат)/i.test(t);
const TRAILING_NUMBER = /(?:№|No|бр|број|номер)?\.?\s*(\d+[А-Яа-яЀ-ӿA-Za-z]?)\s*$/i;
const PART_BOUNDARY =
  String.raw`(?=[,;]|\s+(?:с\.|село|гр\.|град|кв\.|ж\.?\s?к|квартал|нас\.|населба|н\.м\.|бл\.|блок|згр\.|зграда|ет\.|ап\.|вх\.|кат|стан|влез|вл\.|бр\.|број|общ\.|општ\.|општина|обл\.|\d{4})|$)`;

function parseHomeAddress(blob, city) {
  const out = {
    quarter: '', street: '', street_number: '', block: '', entry: '',
    floor: '', apartment: '', city: '', postal_code: '',
  };
  const providedCity = looksLikeCourier(city) ? '' : cleanAddr(city);
  if (providedCity) out.city = providedCity;
  const raw = cleanAddr(blob);
  if (!raw || looksLikeCourier(raw)) return out;

  let residue = ` ${raw} `;
  const grab = (re, set) => {
    const m = residue.match(re);
    if (m) { set(m); residue = residue.replace(m[0], ' '); }
  };

  grab(/(?:^|[\s,])обл(?:аст)?\.?\s*[А-Яа-яA-Za-z. '-]+/i, () => {});
  grab(/(?:^|[\s,])сем(?:ейство)?\.?\s+[А-Яа-я][А-Яа-я-]+/i, () => {});
  grab(/(?<!\d)\d{4}(?!\d)/, (m) => { out.postal_code = m[0].trim(); });
  grab(/(?:^|[\s,(])бл\.?\s*(\d[0-9A-Za-zА-Яа-я]*)/i, (m) => { out.block = m[1]; });
  grab(/(?:^|[\s,(])вх\.?\s*(?:од)?\s*([0-9A-Za-zА-Яа-я]+)/i, (m) => { out.entry = m[1]; });
  grab(/(?:^|[\s,(])ет\.?\s*(?:аж)?\s*(\d+)/i, (m) => { out.floor = m[1]; });
  grab(/(?:^|[\s,(])ап\.?\s*(?:артамент)?\s*(\d+)/i, (m) => { out.apartment = m[1]; });
  grab(new RegExp(String.raw`(?:^|[\s,])((?:кв\.|ж\.?\s?к\.?|квартал)\s*[А-Яа-яA-Za-z0-9 .'-]+?)` + PART_BOUNDARY, 'i'),
    (m) => { out.quarter = cleanAddr(m[1]); });
  if (!out.city) {
    grab(new RegExp(String.raw`(?:^|[\s,])(с\.\s*[А-Яа-яA-Za-z .'-]+?)` + PART_BOUNDARY, 'i'),
      (m) => { out.city = cleanAddr(m[1]); });
    if (!out.city) {
      grab(new RegExp(String.raw`(?:^|[\s,])(гр\.\s*[А-Яа-яA-Za-z .'-]+?)` + PART_BOUNDARY, 'i'),
        (m) => { out.city = cleanAddr(m[1]); });
    }
  } else {
    grab(new RegExp(String.raw`(?:^|[\s,])(?:с\.|гр\.)\s*[А-Яа-яA-Za-z .'-]+?` + PART_BOUNDARY, 'i'), () => {});
  }
  grab(new RegExp(String.raw`((?:ул\.?|бул\.?|пл\.)\s*[А-Яа-яA-Za-z0-9 .№#'-]+?)` + PART_BOUNDARY, 'i'),
    (m) => { out.street = cleanAddr(m[1]); });
  if (!out.street) {
    const rem = cleanAddr(residue);
    if (rem && /[А-Яа-яA-Za-z]/.test(rem)) out.street = rem;
  }
  // trailing house number → street_number
  const street = out.street;
  if (street && !out.street_number) {
    const nm = street.match(TRAILING_NUMBER);
    if (nm && nm.index !== undefined && nm.index > 0) {
      out.street = cleanAddr(street.slice(0, nm.index));
      out.street_number = nm[1];
    }
  }
  return out;
}

/* ── data ────────────────────────────────────────────────────────────────── */

async function loadAll(build) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await build().range(from, from + 999);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  return rows;
}

const FIELDS = ['street', 'street_number', 'quarter', 'block', 'entry', 'floor', 'apartment', 'city', 'postal_code'];

async function main() {
  console.log(`mode: ${COMMIT ? 'COMMIT' : 'dry run'}\n`);

  console.log('Loading MEX zone map…');
  const settlements = await loadAll(() => supabase
    .from('mk_settlements')
    .select('name_norm, mex_city_id, mex_cities(city_name)')
    .not('mex_city_id', 'is', null));
  const byNorm = new Map();
  for (const s of settlements) {
    if (!byNorm.has(s.name_norm)) byNorm.set(s.name_norm, { id: s.mex_city_id, name: s.mex_cities?.city_name ?? null });
  }

  console.log('Loading orders…');
  const orders = await loadAll(() => supabase
    .from('orders')
    .select('customer_phone, customer_address, customer_city, postal_code, street, street_number, quarter, block, entry, floor, apartment, created_at')
    .order('created_at', { ascending: false }));
  const hasSignal = (o) =>
    !!((o.customer_address || '').trim() || (o.street || '').trim() || (o.quarter || '').trim()
      || (o.street_number || '').trim() || (o.block || '').trim());
  console.log(`${orders.length.toLocaleString('en-US')} orders, ${orders.filter(hasSignal).length.toLocaleString('en-US')} with an address signal.`);

  // Newest ADDRESS-BEARING order per phone wins (a newer order with no address
  // must not shadow an older one that has it); the newest order of any kind is
  // kept separately as the city fallback. Every blob the phone ever had is
  // remembered for the machine-written-street detection.
  const newestByPhone = new Map();
  const newestAnyByPhone = new Map();
  const blobsByPhone = new Map();
  for (const o of orders) {
    const p = o.customer_phone;
    if (!p) continue;
    if (!newestAnyByPhone.has(p)) newestAnyByPhone.set(p, o);
    if (hasSignal(o) && !newestByPhone.has(p)) newestByPhone.set(p, o);
    const blob = (o.customer_address || '').trim();
    if (blob) {
      if (!blobsByPhone.has(p)) blobsByPhone.set(p, new Set());
      blobsByPhone.get(p).add(blob);
    }
  }

  console.log('Loading profiles…');
  const profiles = await loadAll(() => supabase
    .from('customer_profiles')
    .select('phone, street, street_number, quarter, block, entry, floor, apartment, city, postal_code, mex_city_id'));
  console.log(`${profiles.length.toLocaleString('en-US')} profiles.\n`);

  const patches = [];
  let machineBlobs = 0, untouchedFull = 0, noSource = 0;
  for (const prof of profiles) {
    const src = newestByPhone.get(prof.phone) ?? newestAnyByPhone.get(prof.phone);
    if (!src) { noSource++; continue; }

    // Machine-written street: byte-identical to one of the customer's own
    // order blobs (that is where POST /api/orders/import copied it from).
    const profStreet = (prof.street || '').trim();
    const isMachineBlob = !!profStreet && (blobsByPhone.get(prof.phone)?.has(profStreet) ?? false);
    if (isMachineBlob) machineBlobs++;

    // Structured order columns win; a blob-only order is parsed apart. Same
    // precedence as effectiveHomeParts in src/lib/address.ts.
    const hasStructured = !!(src.street || src.quarter || src.street_number || src.block);
    const parsed = hasStructured
      ? {
          street: src.street || '', street_number: src.street_number || '', quarter: src.quarter || '',
          block: src.block || '', entry: src.entry || '', floor: src.floor || '', apartment: src.apartment || '',
          city: looksLikeCourier(src.customer_city) ? '' : cleanAddr(src.customer_city),
          postal_code: src.postal_code || '',
        }
      : parseHomeAddress(src.customer_address, src.customer_city);

    const patch = {};
    for (const f of FIELDS) {
      const cur = f === 'street' && isMachineBlob ? '' : String(prof[f] ?? '').trim();
      const val = cleanAddr(parsed[f]);
      // For street, never "replace" the machine blob with itself — only a parse
      // that actually split something out is worth writing.
      if (!cur && val && !(f === 'street' && val === profStreet)) patch[f] = val;
    }

    // MEX zone, only when empty and the (new or existing) city resolves.
    if (prof.mex_city_id == null) {
      const cityForZone = patch.city || String(prof.city ?? '').trim();
      if (cityForZone) {
        const key = normalizeMkGeo(cityForZone.split(',')[0].replace(/^\s*(гр\.?|с\.?|село|град)\s*/i, '').trim());
        const zone = key ? byNorm.get(key) : null;
        if (zone) { patch.mex_city_id = zone.id; patch.mex_city_name = zone.name; }
      }
    }

    if (Object.keys(patch).length) patches.push({ phone: prof.phone, patch });
    else untouchedFull++;
  }

  console.log(`profiles with a fill-only patch : ${patches.length.toLocaleString('en-US')}`);
  console.log(`  of which machine-blob streets : ${machineBlobs.toLocaleString('en-US')}`);
  console.log(`already complete / nothing new  : ${untouchedFull.toLocaleString('en-US')}`);
  console.log(`no address-bearing order        : ${noSource.toLocaleString('en-US')}`);

  const fieldTally = {};
  for (const { patch } of patches) for (const k of Object.keys(patch)) fieldTally[k] = (fieldTally[k] || 0) + 1;
  console.log('\nfields to be filled:');
  for (const [k, n] of Object.entries(fieldTally).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(16)} ${String(n).padStart(7)}`);
  }
  // Street-bearing patches first — they are the ones worth eyeballing; a
  // zone-only patch is mechanical.
  const interesting = patches.filter(({ patch }) => patch.street || patch.street_number || patch.city);
  console.log('\nsample (street-bearing first):');
  for (const { phone, patch } of [...interesting.slice(0, 10), ...patches.slice(0, 3)]) {
    console.log(`  ${phone}  ${JSON.stringify(patch)}`);
  }

  if (!COMMIT) { console.log('\nDRY RUN — nothing written. Re-run with --commit.'); return; }

  let done = 0;
  for (const { phone, patch } of patches) {
    const { error } = await supabase.from('customer_profiles').update(patch).eq('phone', phone);
    if (error) throw new Error(`${phone}: ${error.message}`);
    done++;
    if (done % 200 === 0) process.stdout.write(`\r  updated ${done}/${patches.length}`);
  }
  console.log(`\n\nDone. ${done.toLocaleString('en-US')} profiles updated (fill-only).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
