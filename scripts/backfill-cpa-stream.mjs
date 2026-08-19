#!/usr/bin/env node
/**
 * Backfill orders.cpa_stream_id — the publisher/traffic-source code
 * (AlterCPA tracking.exts), third attribution dimension after wm/offer.
 *
 *   node scripts/backfill-cpa-stream.mjs            # DRY RUN (default)
 *   node scripts/backfill-cpa-stream.mjs --apply
 *   node scripts/backfill-cpa-stream.mjs --apply --limit 500   # smoke test
 *
 * Clone of backfill-cpa-attribution.mjs with three deliberate deltas:
 *
 *   1. Single column, read from `tracking.exts` (dump) /
 *      payload->'tracking'->>'exts' (ledger). Empty string → NULL — 14,8% of
 *      the history has no exts, and the UI hides the line rather than show a
 *      placeholder. NEVER tracking.extu: that is a per-lead click id.
 *   2. The ledger wins ONLY when its exts is non-null. The 3-column script's
 *      unconditional ledger-wins is correct there because wm/offer exist on
 *      every ledger row — exts is optional, and a null observation from the
 *      ledger must not clobber a real code captured in the dump.
 *   3. No sighting step: streams have no registry by design (operator decision
 *      2026-08-19 — raw codes, no names), and the WEBMASTER queue's seen_count
 *      must not be touched by this script.
 *
 * Trigger suppression and idempotency are inherited unchanged: every batch runs
 * inside BEGIN; SET LOCAL session_replication_role = replica; … COMMIT; so
 * trg_orders_updated_at cannot stamp ~69k rows (GET /call-agains reports
 * orders.updated_at as last_call_at), and the IS DISTINCT FROM guard makes a
 * second run report 0 changes. Refuses to run unless supabase/config.toml
 * points at Macedonia.
 */
import { readFileSync, existsSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'scripts', 'data', 'altercpa-mk-raw.jsonl');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';
const BATCH = 2000;

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const LIMIT = (() => { const i = args.indexOf('--limit'); return i >= 0 ? Number(args[i + 1]) : 0; })();

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const fail = (m) => { console.error(c(31, `✗ ${m}`)); process.exit(1); };
const num = (n) => Number(n).toLocaleString('en-US').replace(/,/g, '.');

// ── Guard: never Bulgaria ───────────────────────────────────────────────────
const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = { ...process.env };
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m && !env[m[1]]) env[m[1]] = m[2];
}
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) fail('SUPABASE_ACCESS_TOKEN missing from .env');

// Management API with gateway-class retry only — a 4xx is our bug and must
// surface immediately, not be hammered.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
async function sql(query, attempt = 0) {
  let res, text;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    text = await res.text();
  } catch (err) {
    if (attempt >= 4) throw err;
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    return sql(query, attempt + 1);
  }
  if (!res.ok) {
    if (RETRYABLE.has(res.status) && attempt < 4) {
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
      return sql(query, attempt + 1);
    }
    throw new Error(`${res.status} ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

const lit = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// exts normaliser: trim, cap at 120 (matches the sync's s(…, 120)), empty → null.
const norm = (v) => {
  const s = v == null ? '' : String(v).trim().slice(0, 120);
  return s || null;
};

console.log(c(1, '\nCPA stream (publisher) backfill') + ` — ${EXPECTED_REF}`);
console.log(APPLY ? c(33, 'MODE: APPLY (writes)') : c(36, 'MODE: dry run (no writes) — pass --apply to write'));
if (LIMIT) console.log(c(33, `LIMIT: first ${num(LIMIT)} orders only`));

// ── 1) Read the historical dump ─────────────────────────────────────────────
if (!existsSync(RAW)) fail(`missing ${RAW} — run scripts/export-altercpa-mk.mjs first`);

/** @type {Map<string, {exts: string|null, wm: string|null}>} */
const streams = new Map();
let rawLines = 0, rawBad = 0, rawWithExts = 0;
{
  const rl = createInterface({ input: createReadStream(RAW), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { rawBad++; continue; }
    if (o?.id == null) { rawBad++; continue; }
    rawLines++;
    const exts = norm(o.tracking?.exts);
    if (exts) rawWithExts++;
    // wm rides along for the preview mix only — the write is single-column.
    streams.set(String(o.id), { exts, wm: o.wm == null ? null : String(o.wm) });
  }
}
console.log(`\n• dump      ${c(1, num(rawLines))} records, ${num(rawWithExts)} with exts (${(100 * rawWithExts / Math.max(1, rawLines)).toFixed(1)}%)${rawBad ? c(33, `  (${rawBad} unparseable, skipped)`) : ''}`);

// ── 2) Union in the live ledger — non-null wins only ────────────────────────
// Unlike the 3-column backfill, the ledger observation only REPLACES the dump's
// when it actually carries a code: a null exts from the ledger must not erase a
// real one captured in the dump for the same id (overlap window ~2026-08-05).
let ledgerRows = 0, ledgerNew = 0;
for (let page = 0; ; page++) {
  const rows = await sql(`
    SELECT altercpa_id, webmaster,
           NULLIF(btrim(payload->'tracking'->>'exts'), '') AS exts
      FROM public.altercpa_leads
     ORDER BY altercpa_id
     LIMIT 5000 OFFSET ${page * 5000};`);
  if (!rows.length) break;
  for (const r of rows) {
    ledgerRows++;
    const key = String(r.altercpa_id);
    const exts = norm(r.exts);
    const prev = streams.get(key);
    if (!prev) { ledgerNew++; streams.set(key, { exts, wm: r.webmaster ?? null }); continue; }
    if (exts) streams.set(key, { exts, wm: r.webmaster ?? prev.wm });
  }
  if (rows.length < 5000) break;
}
console.log(`• ledger    ${c(1, num(ledgerRows))} rows (${num(ledgerNew)} not in the dump — post-2026-08-05 leads)`);
console.log(`• combined  ${c(1, num(streams.size))} distinct AlterCPA ids`);

// ── 3) Which orders need it ────────────────────────────────────────────────
const [before] = await sql(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE cpa_stream_id IS NOT NULL)::int AS attributed
    FROM public.orders WHERE external_source = 'altercpa';`);
console.log(`\n• orders with external_source='altercpa': ${c(1, num(before.total))} (already carry a stream: ${num(before.attributed)})`);

const targets = [];
let noExts = 0;
for (let page = 0; ; page++) {
  const rows = await sql(`
    SELECT external_order_id, cpa_stream_id
      FROM public.orders
     WHERE external_source = 'altercpa' AND external_order_id IS NOT NULL
     ORDER BY external_order_id
     LIMIT 5000 OFFSET ${page * 5000};`);
  if (!rows.length) break;
  for (const r of rows) {
    const a = streams.get(String(r.external_order_id));
    if (!a) { targets.push({ ext: r.external_order_id, missing: true }); continue; }
    if (!a.exts) { noExts++; continue; }          // no code recorded — stays NULL
    // Mirrors the SQL guard below, so the number reported and the number
    // written are the same number.
    if (r.cpa_stream_id === a.exts) continue;
    targets.push({ ext: r.external_order_id, exts: a.exts, wm: a.wm });
  }
  if (rows.length < 5000) break;
}

const missing = targets.filter((t) => t.missing);
let writable = targets.filter((t) => !t.missing);
if (LIMIT) writable = writable.slice(0, LIMIT);

console.log(`• would update ${c(1, num(writable.length))} orders  (${num(noExts)} have no exts in either source — stay NULL)`);
if (missing.length) {
  console.log(c(33, `• ${num(missing.length)} orders have an external_order_id absent from BOTH sources — left untouched`));
  console.log(c(90, `    e.g. ${missing.slice(0, 8).map((m) => m.ext).join(', ')}`));
}

// Preview: top streams per webmaster, to eyeball against AlterCPA's own
// "Lead distribution by affiliate traffic sources" panel BEFORE writing.
const mix = new Map();
for (const t of writable) {
  const k = `${t.wm ?? '(none)'} · ${t.exts}`;
  mix.set(k, (mix.get(k) || 0) + 1);
}
console.log(c(1, `\n  wm · stream                          orders   (top 20 of ${num(mix.size)} distinct)`));
for (const [k, v] of [...mix].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
  console.log(`  ${String(k).padEnd(36)} ${String(num(v)).padStart(7)}`);
}

if (!writable.length) {
  console.log(c(32, '\n✓ nothing to do — every order already carries its stream.\n'));
  process.exit(0);
}

if (!APPLY) {
  console.log(c(36, '\nDry run complete. Re-run with --apply to write.\n'));
  process.exit(0);
}

// ── 4) Write ───────────────────────────────────────────────────────────────
// One transaction per batch. session_replication_role = replica is SET LOCAL,
// so it reverts at COMMIT and never leaks to another session.
let written = 0;
for (let i = 0; i < writable.length; i += BATCH) {
  const slice = writable.slice(i, i + BATCH);
  const values = slice.map((t) => `(${lit(t.ext)},${lit(t.exts)})`).join(',');
  await sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    WITH v(ext_id, exts) AS (VALUES ${values})
    UPDATE public.orders o
       SET cpa_stream_id = v.exts
      FROM v
     WHERE o.external_source = 'altercpa'
       AND o.external_order_id = v.ext_id
       AND o.cpa_stream_id IS DISTINCT FROM v.exts;
    COMMIT;`);
  written += slice.length;
  process.stdout.write(`\r  written ${num(written)} / ${num(writable.length)}   `);
}
console.log('');

// ── 5) Prove it ────────────────────────────────────────────────────────────
const [after] = await sql(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE cpa_stream_id IS NOT NULL)::int AS attributed
    FROM public.orders WHERE external_source = 'altercpa';`);
console.log(`\n• with a stream code: ${c(32, num(after.attributed))} / ${num(after.total)}`);

// A stream code should never span two webmasters (measured: 0 of ~200). If one
// ever does, both rows render honestly in the UI — but say so here.
const collisions = await sql(`
  SELECT cpa_stream_id, count(DISTINCT cpa_webmaster_id)::int AS wms
    FROM public.orders
   WHERE cpa_stream_id IS NOT NULL
   GROUP BY 1 HAVING count(DISTINCT cpa_webmaster_id) > 1;`);
if (collisions.length) {
  console.log(c(33, `• ⚠ ${collisions.length} stream code(s) span more than one webmaster: ${collisions.slice(0, 5).map((r) => r.cpa_stream_id).join(', ')}`));
} else {
  console.log('• collision probe: 0 stream codes span webmasters ✓');
}

const split = await sql(`
  SELECT o.cpa_stream_id AS stream, COALESCE(w.name, '#' || o.cpa_webmaster_id, '(none)') AS aff, count(*)::int AS n
    FROM public.orders o
    LEFT JOIN public.altercpa_webmasters w ON w.wm_id = o.cpa_webmaster_id
   WHERE o.cpa_stream_id IS NOT NULL
   GROUP BY 1, 2 ORDER BY n DESC LIMIT 15;`);
console.log(c(1, '\n  stream                aff             orders'));
for (const r of split) {
  console.log(`  ${String(r.stream).padEnd(20)}  ${String(r.aff).padEnd(14)} ${String(num(r.n)).padStart(7)}`);
}

console.log(c(32, '\n✓ done.\n'));
