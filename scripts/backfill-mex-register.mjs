#!/usr/bin/env node
/**
 * Backfill the MEX parcel register — public.mex_parcels — from BOTH MEX
 * accounts, then link every parcel an existing order already points at.
 *
 *   node scripts/backfill-mex-register.mjs                     # DRY RUN (default)
 *   node scripts/backfill-mex-register.mjs --apply             # write
 *   node scripts/backfill-mex-register.mjs --from 2026-01-01   # window start (default 2026-04-01)
 *   node scripts/backfill-mex-register.mjs --account natura    # one account only
 *
 * Why: mex-reconcile upserts every shipment it sees into mex_parcels, but only
 * for its rolling window. This loads the history once — MEX's side of the
 * ledger, matched to an order or not — so "which parcels have no order" and
 * "which orders hold a parcel they shouldn't" become queries.
 *
 * DRY RUN (the default) fetches from MEX (read-only list endpoint) and reads
 * orders (SELECT only), then reports counts per account and a preview of the
 * link step. Nothing is written to the database.
 *
 * --apply:
 *   0. runs scripts/assert-mk-target.mjs (the tripwire) first; aborts on failure
 *   1. mex_upsert_parcels(account, rows) in batches of 500 — the raw
 *      list_shipments rows exactly as MEX returned them. Idempotent: a re-run
 *      re-upserts the same rows.
 *   2. ONE SQL statement links parcels to the orders already holding their
 *      tracking id: mex_parcels.order_id / link_method ('collabbox_import' when
 *      the order came from collabBox, else 'tracking') / linked_at — only where
 *      order_id IS NULL and the order is not 'duplicated'. Two or more holders
 *      (the ghost doubles: a teleshop import plus a 0 ден call disposition that
 *      a pre-fix mex-reconcile run linked to the same parcel) → the ONE real
 *      sale (price > 0, a real product name). Anything else stays unlinked and
 *      is REPORTED — never guessed.
 *   3. copies the parcel facts onto the orders just linked (step 1 ran before
 *      the links existed) with ONE UPDATE under SET LOCAL
 *      session_replication_role = replica, so NO trigger fires — in
 *      particular not trg_orders_updated_at: GET /call-agains reports
 *      orders.updated_at as last_call_at, and bumping it on ~19k orders would
 *      make all of them look freshly called. Each order takes the facts of the
 *      parcel its own mex_tracking_id names (the same rule mex_upsert_parcels
 *      uses for later syncs).
 *
 * A single holder is linked as it stands, even a 0 ден disposition: the register
 * mirrors what orders.mex_tracking_id says today. Those rows are listed in the
 * report for the ghost repair, which must move the link with mex_link_parcel
 * (p_force) or clear both sides.
 *
 * Keys (never printed): BIO NATURAL = env MEX_API_KEY, else the first 40-hex
 * backticked key in docs/VAULT.md §6; NATURA = env MEX_API_KEY_2, else the
 * backticked token after "SECOND ACCOUNT" in §6. NATURA holds ~158k parcels back
 * to 2022 — --from keeps the sweep to the period that matters.
 *
 * Database access is the Management API (SUPABASE_ACCESS_TOKEN) with the MK ref
 * hard-coded; refuses to run unless supabase/config.toml points at Macedonia.
 * The full report (tracking ids, order numbers — no phones, no names) is written
 * to exports/mex-register/ (gitignored).
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';       // MACEDONIA. never change.
const MEX_BASE = 'https://mex.mk/api/json';
const PER_PAGE = 500;
const BATCH = 500;                                 // mex_upsert_parcels takes ≤ 500 rows
const MAX_PAGES = 1000;                            // runaway total_pages guard (500k parcels)

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const FROM = opt('--from') ?? '2026-04-01';
const ONLY = opt('--account');

const c = (n, s) => `\x1b[${n}m${s}\x1b[0m`;
const fail = (m) => { console.error(c(31, `✗ ${redact(m)}`)); process.exit(1); };
const num = (n) => Number(n).toLocaleString('en-US').replace(/,/g, '.');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every key this script holds is scrubbed from anything it prints.
const secrets = [];
function redact(s) {
  let out = String(s);
  for (const k of secrets) if (k) out = out.split(k).join('<redacted>');
  return out;
}

if (!/^\d{4}-\d{2}-\d{2}$/.test(FROM)) fail(`--from must be YYYY-MM-DD (got "${FROM}")`);
if (ONLY && !['bio_natural', 'natura'].includes(ONLY)) fail(`--account must be bio_natural or natura (got "${ONLY}")`);
if (APPLY && args.includes('--dry-run')) fail('pass --dry-run or --apply, not both');

// ── Guard: never Bulgaria ─────────────────────────────────────────────────────
const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = { ...process.env };
try {
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !env[m[1]]) env[m[1]] = m[2];
  }
} catch { /* .env optional when vars are exported */ }
for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL']) {
  if (env[k] && !env[k].includes(EXPECTED_REF)) fail(`.env ${k} does not point at ${EXPECTED_REF}`);
}
const token = env.SUPABASE_ACCESS_TOKEN;
secrets.push(token);

// ── MEX keys ──────────────────────────────────────────────────────────────────
function vaultSection6() {
  try {
    const t = readFileSync(join(ROOT, 'docs', 'VAULT.md'), 'utf8');
    const s = t.indexOf('## §6');
    if (s < 0) return '';
    const e = t.indexOf('\n## ', s + 5);
    return t.slice(s, e < 0 ? undefined : e);
  } catch { return ''; }
}
const sec6 = vaultSection6();
const vaultKey = {
  bio_natural: sec6.match(/`([0-9a-f]{40})`/i)?.[1] ?? '',
  natura: (() => {
    const i = sec6.indexOf('SECOND ACCOUNT');
    return i < 0 ? '' : (sec6.slice(i).match(/`([A-Za-z0-9+\/=_-]{20,})`/)?.[1] ?? '');
  })(),
};
const accounts = [
  { label: 'bio_natural', name: 'BIO NATURAL', envName: 'MEX_API_KEY' },
  { label: 'natura', name: 'NATURA', envName: 'MEX_API_KEY_2' },
]
  .filter((a) => !ONLY || a.label === ONLY)
  .map((a) => ({
    ...a,
    key: env[a.envName] || vaultKey[a.label],
    keySource: env[a.envName] ? `env ${a.envName}` : vaultKey[a.label] ? 'docs/VAULT.md §6' : null,
  }));
for (const a of accounts) {
  if (!a.key) fail(`no key for ${a.name}: set ${a.envName} or keep it in docs/VAULT.md §6`);
  secrets.push(a.key);
}

// ── Management API (SQL) ──────────────────────────────────────────────────────
// Gateway-class retry only — a 4xx is our bug and must surface immediately.
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);
async function sql(query, attempt = 0) {
  if (!token) fail('SUPABASE_ACCESS_TOKEN missing from .env');
  let res, text;
  try {
    res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    text = await res.text();
  } catch (err) {
    if (attempt >= 4) throw new Error(redact(err.message));
    await sleep(1000 * 2 ** attempt);
    return sql(query, attempt + 1);
  }
  if (!res.ok) {
    if (RETRYABLE.has(res.status) && attempt < 4) {
      await sleep(1000 * 2 ** attempt);
      return sql(query, attempt + 1);
    }
    throw new Error(redact(`${res.status} ${text.slice(0, 400)}`));
  }
  return JSON.parse(text);
}
const lit = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

// ── Real-sale rule: JS and SQL twins of match.ts isRealSale ───────────────────
// Mirror of isSyntheticProductName in src/lib/utils.ts — keep in step.
const isSyntheticProductName = (name) => {
  const n = String(name || '').trim();
  if (!n || n === '—') return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
};
const isRealSale = (o) => Number(o.price) > 0 && !isSyntheticProductName(o.product_name) && o.status !== 'duplicated';
const linkMethodOf = (o) => (o.external_source === 'collabbox' ? 'collabbox_import' : 'tracking');

const REAL_SALE_SQL = `(COALESCE(o.price, 0) > 0
          AND btrim(COALESCE(o.product_name, ''), E' \\t\\r\\n') NOT IN ('', '—')
          AND btrim(o.product_name, E' \\t\\r\\n') !~* '^(Cancelled|Trashed|No prior product on file)')`;
// Unlinked parcels and every non-duplicated order holding their tracking id,
// with how many holders / real sales each parcel has.
const HOLDERS_CTE = `
  holders AS (
    SELECT p.tracking_id, o.id AS order_id, o.external_source, ${REAL_SALE_SQL} AS real_sale
      FROM public.mex_parcels p
      JOIN public.orders o ON o.mex_tracking_id = p.tracking_id
     WHERE p.order_id IS NULL
       AND o.status <> 'duplicated'
  ),
  ranked AS (
    SELECT h.*,
           count(*) OVER (PARTITION BY h.tracking_id)                            AS n_holders,
           count(*) FILTER (WHERE h.real_sale) OVER (PARTITION BY h.tracking_id) AS n_real
      FROM holders h
  )`;
const LINK_SQL = `
WITH ${HOLDERS_CTE}
UPDATE public.mex_parcels p
   SET order_id    = r.order_id,
       link_method = CASE WHEN r.external_source = 'collabbox' THEN 'collabbox_import' ELSE 'tracking' END,
       linked_at   = now()
  FROM ranked r
 WHERE p.tracking_id = r.tracking_id
   AND p.order_id IS NULL
   AND (r.n_holders = 1 OR (r.real_sale AND r.n_real = 1))
RETURNING p.tracking_id, p.link_method;`;
// What the link statement leaves behind: unlinked parcels with 2+ holders and
// not exactly one real sale among them.
const CONFLICTS_SQL = `
WITH ${HOLDERS_CTE}
SELECT r.tracking_id, p.account, o.display_id, o.status, o.price, o.product_name, o.external_source
  FROM ranked r
  JOIN public.orders o      ON o.id = r.order_id
  JOIN public.mex_parcels p ON p.tracking_id = r.tracking_id
 WHERE NOT (r.n_holders = 1 OR (r.real_sale AND r.n_real = 1))
 ORDER BY r.tracking_id, o.display_id;`;

// ── MEX fetch ─────────────────────────────────────────────────────────────────
async function mexPage(acct, page) {
  const url = `${MEX_BASE}/list_shipments.php?updated_from=${FROM}&per_page=${PER_PAGE}&page=${page}&order=last_update_asc`;
  let last;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { AuthKey: acct.key }, signal: AbortSignal.timeout(60_000) });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`non-JSON body: ${text.slice(0, 160)}`); }
      if (j?.success !== 1 || !Array.isArray(j.shipments)) throw new Error(`error body: ${text.slice(0, 200)}`);
      return j;
    } catch (e) {
      last = e;
      if (attempt < 4) await sleep(1000 * 2 ** attempt);
    }
  }
  throw new Error(redact(`MEX ${acct.name} page ${page}: ${last?.message}`));
}

async function fetchAccount(acct) {
  const rows = [];
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    if (page > MAX_PAGES) fail(`${acct.name}: more than ${MAX_PAGES} pages — narrow --from`);
    const j = await mexPage(acct, page);
    totalPages = Math.max(1, Number(j.total_pages || 1));
    rows.push(...j.shipments);
    process.stdout.write(`\r  ${acct.name.padEnd(11)} page ${page}/${totalPages} · ${num(rows.length)} rows   `);
    if (!j.shipments.length) break;
  }
  process.stdout.write('\n');
  return rows;
}

const parseCod = (raw) => Math.round(Number(String(raw ?? '').replace(/[^\d.]/g, '')) || 0);

// ═════════════════════════════════════════════════════════════════════════════
console.log(c(1, '\nMEX parcel register backfill') + ` — ${EXPECTED_REF}`);
console.log(APPLY ? c(33, 'MODE: APPLY (writes)') : c(36, 'MODE: dry run (no writes) — pass --apply to write'));
console.log(`window: updated_from ${FROM}` + (ONLY ? ` · account ${ONLY} only` : ''));
for (const a of accounts) console.log(`key ${a.name.padEnd(11)} ← ${a.keySource}`);

if (APPLY) {
  console.log(c(1, '\n── tripwire ──'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { stdio: 'inherit', cwd: ROOT });
  } catch {
    fail('scripts/assert-mk-target.mjs did not pass — nothing written');
  }
}

// ── 1) Fetch ──────────────────────────────────────────────────────────────────
console.log(c(1, '\n── 1. fetch from MEX ──'));
const byAccount = new Map();          // label → Map(tracking_id → raw row)
const summary = {};
for (const acct of accounts) {
  const rows = await fetchAccount(acct);
  const unique = new Map();
  for (const r of rows) {
    if (!r?.tracking_id) continue;
    unique.delete(r.tracking_id);     // last occurrence wins (pages are last_update_asc)
    unique.set(r.tracking_id, r);
  }
  byAccount.set(acct.label, unique);

  const status = {};
  let created0 = null, created1 = null, deliveredCod = 0;
  const idTypes = new Set();
  for (const r of unique.values()) {
    idTypes.add(typeof r.current_status_id);
    const k = `${r.current_status_id} ${r.current_status_name ?? ''}`.trim();
    status[k] = (status[k] || 0) + 1;
    const cr = r.created_at ? String(r.created_at) : null;
    if (cr && (!created0 || cr < created0)) created0 = cr;
    if (cr && (!created1 || cr > created1)) created1 = cr;
    if (Number(r.current_status_id) === 2) deliveredCod += parseCod(r.cod);
  }
  summary[acct.label] = {
    fetched: rows.length, unique: unique.size, repeated: rows.length - unique.size,
    no_tracking_id: rows.filter((r) => !r?.tracking_id).length,
    created_from: created0, created_to: created1, delivered_cod_mkd: deliveredCod, status,
    status_id_type: [...idTypes].join('/'),
  };
  console.log(`  ${acct.name.padEnd(11)} ${c(1, num(unique.size))} parcels (${num(rows.length)} rows fetched`
    + `${rows.length - unique.size ? `, ${num(rows.length - unique.size)} repeated across pages` : ''})`
    + ` · created ${created0?.slice(0, 10) ?? '—'} … ${created1?.slice(0, 10) ?? '—'}`
    + ` · delivered COD ${num(deliveredCod)} ден`);
  const top = Object.entries(status).sort((a, b) => b[1] - a[1]);
  console.log(c(90, `              status: ${top.map(([k, v]) => `${k} ${num(v)}`).join(' · ')}  (status id arrives as ${[...idTypes].join('/')})`));
}

// Tracking ids are disjoint across the two accounts (verified 2026-09-18). The
// register's key is tracking_id, so an overlap would flip-flop a parcel's account.
const overlap = [];
if (byAccount.size === 2) {
  const [a, b] = [...byAccount.values()];
  for (const id of a.keys()) if (b.has(id)) overlap.push(id);
}
if (overlap.length) {
  console.log(c(31, `  ⚠ ${overlap.length} tracking id(s) appear in BOTH accounts: ${overlap.slice(0, 10).join(', ')}`));
} else if (byAccount.size === 2) {
  console.log('  account overlap: 0 tracking ids ✓');
}

const parcels = new Map();            // tracking_id → account label
for (const [label, rows] of byAccount) for (const id of rows.keys()) if (!parcels.has(id)) parcels.set(id, label);

// ── 2) Link preview from orders (SELECT only) ─────────────────────────────────
console.log(c(1, '\n── 2. link preview (orders already holding a tracking id) ──'));
let preview = null;
if (!token) {
  console.log(c(33, '  SUPABASE_ACCESS_TOKEN missing — preview skipped (and --apply would refuse)'));
} else {
  const holdersAll = [];
  for (let last = '00000000-0000-0000-0000-000000000000'; ;) {
    const page = await sql(`
      SELECT o.id, o.display_id, o.mex_tracking_id, o.status, o.price, o.product_name, o.external_source
        FROM public.orders o
       WHERE o.mex_tracking_id IS NOT NULL
         AND o.id > ${lit(last)}::uuid
       ORDER BY o.id
       LIMIT 5000;`);
    holdersAll.push(...page);
    if (page.length < 5000) break;
    last = page[page.length - 1].id;
  }
  const dupHolders = holdersAll.filter((o) => o.status === 'duplicated');
  const byTrack = new Map();
  for (const o of holdersAll) {
    if (o.status === 'duplicated') continue;
    const arr = byTrack.get(o.mex_tracking_id) ?? [];
    arr.push(o);
    byTrack.set(o.mex_tracking_id, arr);
  }

  const brief = (o) => ({
    order: o.display_id, id: o.id, status: o.status, price_eur: Number(o.price),
    product: o.product_name, source: o.external_source, real_sale: isRealSale(o),
  });
  const p = {
    no_holder: 0, link: { tracking: 0, collabbox_import: 0 },
    single_not_a_sale: [], doubles_resolved: [], conflicts: [], outside_window: [],
  };
  for (const [id, account] of parcels) {
    const hs = byTrack.get(id) ?? [];
    if (!hs.length) { p.no_holder++; continue; }
    if (hs.length === 1) {
      p.link[linkMethodOf(hs[0])]++;
      if (!isRealSale(hs[0])) p.single_not_a_sale.push({ tracking_id: id, account, ...brief(hs[0]) });
      continue;
    }
    const real = hs.filter(isRealSale);
    if (real.length === 1) {
      p.link[linkMethodOf(real[0])]++;
      p.doubles_resolved.push({ tracking_id: id, account, linked: brief(real[0]), left_holding: hs.filter((o) => o !== real[0]).map(brief) });
    } else {
      p.conflicts.push({ tracking_id: id, account, holders: hs.map(brief) });
    }
  }
  for (const [id, hs] of byTrack) if (!parcels.has(id)) p.outside_window.push(...hs.map((o) => ({ tracking_id: id, ...brief(o) })));
  preview = { ...p, duplicated_holders: dupHolders.length, orders_holding_a_tracking_id: holdersAll.length };

  const linkN = p.link.tracking + p.link.collabbox_import;
  console.log(`  orders holding a tracking id           ${num(holdersAll.length)} (${num(dupHolders.length)} of them 'duplicated' — never linked)`);
  console.log(`  parcels no order holds                 ${num(p.no_holder)}  (matching's job, or sales that exist only at MEX)`);
  console.log(`  parcels to link                        ${c(1, num(linkN))}  (tracking ${num(p.link.tracking)} · collabbox_import ${num(p.link.collabbox_import)})`);
  console.log(`    sole holder is NOT a real sale       ${num(p.single_not_a_sale.length)}  (0 ден dispositions a pre-fix run linked — linked as-is, listed for the repair)`);
  console.log(`    ghost doubles → the one real sale    ${num(p.doubles_resolved.length)}`);
  console.log(`  conflicts left unlinked                ${p.conflicts.length ? c(33, num(p.conflicts.length)) : '0'}`);
  console.log(`  orders whose tracking id MEX did not return since ${FROM}: ${num(p.outside_window.length)}`);

  if (p.doubles_resolved.length) {
    console.log(c(1, '\n  ghost doubles — linked to the real sale, the other holder listed for the repair:'));
    for (const d of p.doubles_resolved) {
      console.log(`    ${d.tracking_id} (${d.account}) → ${d.linked.order} [${d.linked.status} €${d.linked.price_eur} ${d.linked.source ?? '-'}]`
        + `   left: ${d.left_holding.map((o) => `${o.order} [${o.status} €${o.price_eur} "${String(o.product ?? '').slice(0, 28)}"]`).join(', ')}`);
    }
  }
  if (p.conflicts.length) {
    console.log(c(33, '\n  CONFLICTS — several orders claim the parcel and none is the single real sale; left unlinked:'));
    for (const k of p.conflicts) {
      console.log(`    ${k.tracking_id} (${k.account}): ${k.holders.map((o) => `${o.order} [${o.status} €${o.price_eur}${o.real_sale ? '' : ' not-a-sale'}]`).join(' · ')}`);
    }
  }
  if (p.single_not_a_sale.length) {
    console.log(c(90, `\n  sole holders that are not a real sale (first 15 of ${p.single_not_a_sale.length}; all in the report):`));
    for (const g of p.single_not_a_sale.slice(0, 15)) {
      console.log(c(90, `    ${g.tracking_id} (${g.account}) ← ${g.order} [${g.status} €${g.price_eur} "${String(g.product ?? '').slice(0, 30)}"]`));
    }
  }
}

// ── 3) Write ──────────────────────────────────────────────────────────────────
const totals = { upserted: 0, delivered_new: 0, returned_new: 0, orders_synced: 0 };
let linkedBy = null, factsSynced = null, postCounts = null, remainingConflicts = null;
let linkedTotal = 0;

// One mex_upsert_parcels call; returns its jsonb result as an object.
async function upsertBatch(label, batch) {
  const [row] = await sql(`SELECT public.mex_upsert_parcels(${lit(label)}, ${lit(JSON.stringify(batch))}::jsonb) AS r;`);
  return typeof row?.r === 'string' ? JSON.parse(row.r) : (row?.r ?? {});
}

if (!APPLY) {
  console.log(c(36, `\nDry run complete — would upsert ${num(parcels.size)} parcels, link ${preview ? num(preview.link.tracking + preview.link.collabbox_import) : '?'} and copy their facts onto those orders. Re-run with --apply to write.`));
} else {
  if (!token) fail('SUPABASE_ACCESS_TOKEN missing — cannot write');
  if (overlap.length) fail(`${overlap.length} tracking id(s) exist in both accounts — refusing to write; investigate first`);

  console.log(c(1, '\n── 3. upsert into mex_parcels ──'));
  for (const [label, rows] of byAccount) {
    const list = [...rows.values()];
    let done = 0;
    for (let i = 0; i < list.length; i += BATCH) {
      const batch = list.slice(i, i + BATCH);
      const r = await upsertBatch(label, batch);
      totals.upserted += Number(r.upserted) || 0;
      totals.delivered_new += Number(r.delivered_new) || 0;
      totals.returned_new += Number(r.returned_new) || 0;
      totals.orders_synced += Number(r.orders_synced) || 0;
      done += batch.length;
      process.stdout.write(`\r  ${label.padEnd(11)} ${num(done)} / ${num(list.length)}   `);
    }
    process.stdout.write('\n');
  }
  console.log(`  upserted ${c(1, num(totals.upserted))} · newly delivered ${num(totals.delivered_new)} · newly returned ${num(totals.returned_new)}`
    + ` · facts copied onto already-linked orders ${num(totals.orders_synced)}`);

  console.log(c(1, '\n── 4. link existing orders ──'));
  const linkedRows = await sql(LINK_SQL);
  linkedTotal = linkedRows.length;
  const byMethod = {};
  for (const r of linkedRows) byMethod[r.link_method] = (byMethod[r.link_method] || 0) + 1;
  linkedBy = Object.entries(byMethod).map(([link_method, n]) => ({ link_method, n }));
  console.log(`  linked ${c(1, num(linkedTotal))}  (${linkedBy.map((r) => `${r.link_method} ${num(r.n)}`).join(' · ') || 'none'})`);

  // Step 3 ran before these links existed, so their orders carry no facts yet.
  // ONE statement with triggers suppressed (session_replication_role = replica,
  // SET LOCAL — reverts at COMMIT; same pattern as backfill-cpa-attribution.mjs).
  // Re-upserting through mex_upsert_parcels would fire trg_orders_updated_at on
  // ~19k orders, and GET /call-agains reports orders.updated_at as last_call_at —
  // every one of those customers would suddenly look freshly called. Only the
  // mex_* fact columns change here; status is untouched, so no status, segment
  // or notification trigger has anything to do anyway.
  console.log(c(1, '\n── 5. copy facts onto the newly linked orders ──'));
  const linkedIds = new Set(linkedRows.map((r) => r.tracking_id));
  factsSynced = { parcels: linkedIds.size, orders_synced: 0, not_in_this_pull: 0 };
  const FACTS_WHERE = `
      FROM public.mex_parcels p
     WHERE p.order_id = o.id
       AND o.mex_tracking_id = p.tracking_id
       AND (o.mex_account        IS DISTINCT FROM p.account
         OR o.mex_status_id      IS DISTINCT FROM p.status_id
         OR o.mex_cod_mkd        IS DISTINCT FROM p.cod_mkd
         OR o.mex_delivered_at   IS DISTINCT FROM p.delivered_at
         OR o.mex_returned_at    IS DISTINCT FROM p.returned_at
         OR o.mex_last_update_at IS DISTINCT FROM p.last_update_at)`;
  const [{ n: pending }] = await sql(`SELECT count(*)::int AS n FROM public.orders o WHERE EXISTS (SELECT 1 ${FACTS_WHERE});`);
  await sql(`
    BEGIN;
    SET LOCAL session_replication_role = replica;
    SET LOCAL statement_timeout = '300s';
    UPDATE public.orders o
       SET mex_account        = p.account,
           mex_status_id      = p.status_id,
           mex_cod_mkd        = p.cod_mkd,
           mex_delivered_at   = p.delivered_at,
           mex_returned_at    = p.returned_at,
           mex_last_update_at = p.last_update_at
    ${FACTS_WHERE};
    COMMIT;`);
  const [{ n: left }] = await sql(`SELECT count(*)::int AS n FROM public.orders o WHERE EXISTS (SELECT 1 ${FACTS_WHERE});`);
  factsSynced.orders_synced = pending - left;
  if (left) console.log(c(33, `  ${num(left)} linked orders still differ from their parcel after the copy — investigate`));
  factsSynced.not_in_this_pull = [...linkedIds].filter((id) => !parcels.has(id)).length;
  console.log(`  orders given their parcel's facts: ${c(1, num(factsSynced.orders_synced))}`
    + (factsSynced.not_in_this_pull
      ? c(33, `  (${num(factsSynced.not_in_this_pull)} linked parcels were registered earlier and are not in this pull — their facts copy on their next sync, or re-run with an earlier --from)`)
      : ''));

  remainingConflicts = await sql(CONFLICTS_SQL);
  const nConf = new Set(remainingConflicts.map((r) => r.tracking_id)).size;
  console.log(`  conflicts left unlinked: ${nConf ? c(33, num(nConf)) : '0'}`);
  for (const r of remainingConflicts.slice(0, 60)) {
    console.log(`    ${r.tracking_id} (${r.account}) ← ${r.display_id} [${r.status} €${Number(r.price)} ${r.external_source ?? '-'} "${String(r.product_name ?? '').slice(0, 28)}"]`);
  }

  postCounts = await sql(`
    SELECT account, count(*)::int AS parcels, count(order_id)::int AS linked
      FROM public.mex_parcels GROUP BY account ORDER BY account;`);
  console.log(c(1, '\n  register now:'));
  for (const r of postCounts) console.log(`    ${String(r.account).padEnd(11)} ${num(r.parcels)} parcels · ${num(r.linked)} linked`);
}

// ── Report ────────────────────────────────────────────────────────────────────
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportDir = join(ROOT, 'exports', 'mex-register');
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, `backfill-${APPLY ? 'apply' : 'dry'}-${stamp}.json`);
writeFileSync(reportPath, JSON.stringify({
  generated: new Date().toISOString(), mode: APPLY ? 'apply' : 'dry-run', from: FROM,
  accounts: summary, overlap, preview,
  apply: APPLY ? {
    totals, linked: linkedTotal, linked_by_method: linkedBy, facts: factsSynced,
    remaining_conflicts: remainingConflicts, register: postCounts,
  } : null,
}, null, 2));

console.log(c(1, '\nSummary'));
for (const a of accounts) {
  const s = summary[a.label];
  console.log(`  fetched ${a.name.padEnd(11)} ${num(s.unique)} parcels`);
}
if (APPLY) {
  console.log(`  upserted            ${num(totals.upserted)}`);
  console.log(`  linked              ${num(linkedTotal)}`);
  console.log(`  orders given facts  ${num((factsSynced?.orders_synced || 0) + totals.orders_synced)}`);
  console.log(`  conflicts           ${num(new Set((remainingConflicts || []).map((r) => r.tracking_id)).size)}`);
} else if (preview) {
  console.log(`  would upsert        ${num(parcels.size)}`);
  console.log(`  would link          ${num(preview.link.tracking + preview.link.collabbox_import)}`);
  console.log(`  conflicts           ${num(preview.conflicts.length)}`);
}
console.log(c(90, `  report → ${reportPath.replace(ROOT, '.')}\n`));
