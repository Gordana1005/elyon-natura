#!/usr/bin/env node
/**
 * Backfill orders.cpa_webmaster_id / cpa_offer_id / cpa_offer_name.
 *
 *   node scripts/backfill-cpa-attribution.mjs            # DRY RUN (default)
 *   node scripts/backfill-cpa-attribution.mjs --apply
 *   node scripts/backfill-cpa-attribution.mjs --apply --limit 500   # smoke test
 *
 * ── Where the data comes from ────────────────────────────────────────────────
 * Two sources, unioned, zero API calls:
 *
 *   1. scripts/data/altercpa-mk-raw.jsonl — 81.657 verbatim comp/list.json
 *      records captured by export-altercpa-mk.mjs, covering 2025-04-14 →
 *      2026-08-05. `wm`, `offer` and `offername` are on every one of them.
 *   2. public.altercpa_leads — the live ledger, which takes over where the dump
 *      stops. The ledger wins on conflict: it is the fresher observation.
 *
 * ── Why triggers are suppressed ──────────────────────────────────────────────
 * Every status-side trigger on `orders` is column-scoped (UPDATE OF status,
 * price, customer_phone), so none of them can fire on these three brand-new
 * columns — no segment recompute, no notification, no affiliate postback, no
 * auto-distribute. The one unscoped trigger is trg_orders_updated_at, and
 * GET /call-agains reports orders.updated_at as `last_call_at` for orders in
 * call_again. Stamping 82k rows would reset that display, so each batch runs
 * inside a transaction with session_replication_role = replica — session-local,
 * so no concurrent writer is affected.
 *
 * Idempotent: the IS DISTINCT FROM guard means a second run reports 0 changes.
 * Refuses to run unless supabase/config.toml points at Macedonia.
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

// The Management API sits behind Cloudflare and returns the occasional 502/504
// on a long run — an HTML error page, not JSON. Retry the gateway classes only:
// a 4xx is our bug and must surface immediately, not be hammered.
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

// Postgres string literal. Everything here is API-sourced text, so quote it
// properly rather than trusting it — the offer catalogue is operator-editable
// and an apostrophe in a name would otherwise end the statement.
const lit = (v) => (v == null || v === '' ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

console.log(c(1, '\nCPA attribution backfill') + ` — ${EXPECTED_REF}`);
console.log(APPLY ? c(33, 'MODE: APPLY (writes)') : c(36, 'MODE: dry run (no writes) — pass --apply to write'));
if (LIMIT) console.log(c(33, `LIMIT: first ${num(LIMIT)} orders only`));

// ── 1) Read the historical dump ─────────────────────────────────────────────
if (!existsSync(RAW)) fail(`missing ${RAW} — run scripts/export-altercpa-mk.mjs first`);

/** @type {Map<string, {wm: string|null, offer: string|null, oname: string|null}>} */
const attribution = new Map();
let rawLines = 0, rawBad = 0;
{
  const rl = createInterface({ input: createReadStream(RAW), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { rawBad++; continue; }
    if (o?.id == null) { rawBad++; continue; }
    rawLines++;
    attribution.set(String(o.id), {
      wm: o.wm == null ? null : String(o.wm),
      offer: o.offer == null ? null : String(o.offer),
      // goods[0].name is what the ledger's offer_name column carries; offername
      // is the OFFER's own name. They are identical on every record we hold, but
      // offername is the authoritative one for this purpose.
      oname: (o.offername || o.goods?.[0]?.name || null) || null,
    });
  }
}
console.log(`\n• dump      ${c(1, num(rawLines))} records${rawBad ? c(33, `  (${rawBad} unparseable, skipped)`) : ''}`);

// ── 2) Union in the live ledger (it takes over where the dump stops) ────────
let ledgerRows = 0, ledgerNew = 0;
for (let page = 0; ; page++) {
  const rows = await sql(`
    SELECT altercpa_id, webmaster, offer_ext_id,
           COALESCE(payload->>'offername', offer_name) AS oname
      FROM public.altercpa_leads
     ORDER BY altercpa_id
     LIMIT 5000 OFFSET ${page * 5000};`);
  if (!rows.length) break;
  for (const r of rows) {
    ledgerRows++;
    if (!attribution.has(String(r.altercpa_id))) ledgerNew++;
    attribution.set(String(r.altercpa_id), {
      wm: r.webmaster ?? null,
      offer: r.offer_ext_id ?? null,
      oname: r.oname ?? null,
    });
  }
  if (rows.length < 5000) break;
}
console.log(`• ledger    ${c(1, num(ledgerRows))} rows (${num(ledgerNew)} not in the dump — post-2026-08-05 leads)`);
console.log(`• combined  ${c(1, num(attribution.size))} distinct AlterCPA ids`);

// ── 3) Which orders need it ────────────────────────────────────────────────
const [before] = await sql(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE cpa_webmaster_id IS NOT NULL)::int AS attributed
    FROM public.orders WHERE external_source = 'altercpa';`);
console.log(`\n• orders with external_source='altercpa': ${c(1, num(before.total))} (already attributed: ${num(before.attributed)})`);

const targets = [];
for (let page = 0; ; page++) {
  const rows = await sql(`
    SELECT external_order_id, cpa_webmaster_id, cpa_offer_id, cpa_offer_name
      FROM public.orders
     WHERE external_source = 'altercpa' AND external_order_id IS NOT NULL
     ORDER BY external_order_id
     LIMIT 5000 OFFSET ${page * 5000};`);
  if (!rows.length) break;
  for (const r of rows) {
    const a = attribution.get(String(r.external_order_id));
    if (!a) { targets.push({ ext: r.external_order_id, missing: true }); continue; }
    // Only rows that would actually change. Mirrors the SQL guard below, so the
    // number reported and the number written are the same number.
    if (r.cpa_webmaster_id === a.wm && r.cpa_offer_id === a.offer && r.cpa_offer_name === a.oname) continue;
    targets.push({ ext: r.external_order_id, ...a });
  }
  if (rows.length < 5000) break;
}

const missing = targets.filter((t) => t.missing);
let writable = targets.filter((t) => !t.missing);
if (LIMIT) writable = writable.slice(0, LIMIT);

console.log(`• would update ${c(1, num(writable.length))} orders`);
if (missing.length) {
  console.log(c(33, `• ${num(missing.length)} orders have an external_order_id absent from BOTH sources — left untouched`));
  console.log(c(90, `    e.g. ${missing.slice(0, 8).map((m) => m.ext).join(', ')}`));
}

// Preview the resulting mix, so the affiliate split can be eyeballed against the
// AlterCPA panel BEFORE anything is written.
const mix = new Map();
for (const t of writable) mix.set(t.wm ?? '(none)', (mix.get(t.wm ?? '(none)') || 0) + 1);
console.log(c(1, '\n  affiliate     orders'));
for (const [k, v] of [...mix].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(k).padEnd(12)} ${String(num(v)).padStart(7)}`);
}

if (!writable.length) {
  console.log(c(32, '\n✓ nothing to do — every order already carries its attribution.\n'));
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
  const values = slice
    .map((t) => `(${lit(t.ext)},${lit(t.wm)},${lit(t.offer)},${lit(t.oname)})`)
    .join(',');
  await sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    WITH v(ext_id, wm, offer, oname) AS (VALUES ${values})
    UPDATE public.orders o
       SET cpa_webmaster_id = v.wm,
           cpa_offer_id     = v.offer,
           cpa_offer_name   = v.oname
      FROM v
     WHERE o.external_source = 'altercpa'
       AND o.external_order_id = v.ext_id
       AND (o.cpa_webmaster_id IS DISTINCT FROM v.wm
         OR o.cpa_offer_id     IS DISTINCT FROM v.offer
         OR o.cpa_offer_name   IS DISTINCT FROM v.oname);
    COMMIT;`);
  written += slice.length;
  process.stdout.write(`\r  written ${num(written)} / ${num(writable.length)}   `);
}
console.log('');

// ── 5) Record every affiliate we saw, so the admin queue is complete ───────
const [account] = await sql('SELECT id FROM public.altercpa_accounts ORDER BY created_at LIMIT 1;');
if (account) {
  const wmCounts = new Map();
  for (const a of attribution.values()) {
    if (a.wm == null) continue;
    wmCounts.set(a.wm, (wmCounts.get(a.wm) || 0) + 1);
  }
  // seen_count ACCUMULATES, so reset the historical baseline first — otherwise a
  // second run doubles it. The counter is a volume hint for the admin queue, not
  // an audited figure, and `name` is never touched by any of this.
  await sql(`UPDATE public.altercpa_webmasters SET seen_count = 0 WHERE account_id = ${lit(account.id)};`);
  for (const [wm, n] of wmCounts) {
    await sql(`SELECT public.altercpa_record_webmaster_sighting(${lit(account.id)}, ${lit(wm)}, ${n});`);
  }
  console.log(`• affiliates in the admin queue: ${c(1, wmCounts.size)}`);
}

// ── 6) Prove it ────────────────────────────────────────────────────────────
const [after] = await sql(`
  SELECT count(*)::int AS total,
         count(*) FILTER (WHERE cpa_webmaster_id IS NOT NULL)::int AS attributed,
         count(*) FILTER (WHERE cpa_offer_id IS NOT NULL)::int AS with_offer
    FROM public.orders WHERE external_source = 'altercpa';`);
console.log(`\n• attributed: ${c(32, num(after.attributed))} / ${num(after.total)}  (offer id on ${num(after.with_offer)})`);

const split = await sql(`
  SELECT COALESCE(o.cpa_webmaster_id, '(none)') AS wm, w.name, count(*)::int AS n
    FROM public.orders o
    LEFT JOIN public.altercpa_webmasters w ON w.wm_id = o.cpa_webmaster_id
   WHERE o.external_source = 'altercpa'
   GROUP BY 1, 2 ORDER BY n DESC;`);
console.log(c(1, '\n  affiliate     name                      orders'));
for (const r of split) {
  console.log(`  ${String(r.wm).padEnd(12)}  ${String(r.name ?? 'unnamed').padEnd(24)} ${String(num(r.n)).padStart(7)}`);
}

console.log(c(32, '\n✓ done.\n'));
