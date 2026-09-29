/**
 * Backfill — orders.collabbox_doc_type for the collabBox orders already in the CRM (migration
 * 20260942000900: the document TYPE decides what a collabBox document is — the DocNumber series can
 * lie, e.g. 703 LEADS-OUT documents are numbered 9102). No shebang (repair-kit convention).
 *
 *   node scripts/backfill-collabbox-doc-types.mjs                      # DRY RUN (default): counts, the
 *                                                                      #   department drift, a CSV of what
 *                                                                      #   cannot be typed — writes nothing
 *   node scripts/backfill-collabbox-doc-types.mjs --apply [--chunk 2000] [--outside-quiet-window]
 *
 * SOURCES (local, read-only)
 *   exports/collabbox/merged-2026-09-28/orders/orders_combined.csv   the header harvest (DocNumber, TipID)
 *   exports/collabbox/*.json                                         every collabbox-fetch output
 *                                                                    (headers[].docNumber / typeId)
 *   A fetch is newer than the harvest and wins for the same DocNumber (the newest fetch last). A
 *   DocNumber the harvest lists under two types that no fetch settles is AMBIGUOUS: never written,
 *   listed in the CSV.
 *
 * WRITES (--apply only): ONLY orders.collabbox_doc_type, ONLY where it IS NULL and the order is a
 * collabBox order, ≤ 2.000 rows per transaction, under SET LOCAL elyon.keep_updated_at = 'on'
 * (GET /call-agains reads updated_at as the last call). No status, money, date or source moves — the
 * department reclass is scripts/reclass-by-folder.mjs (the main session). An order whose stored type
 * differs from the files is listed, never overwritten. Re-runnable; the column is new, so an undo is
 * UPDATE orders SET collabbox_doc_type = NULL WHERE external_source = 'collabbox'.
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards; the token can write Bulgaria too).
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  parseArgs, printTable, q, qUuid, fileStamp, writeCsv,
} from './lib/repair-kit.mjs';
import { csvObjects } from './lib/teleshop-import.mjs';

export const KEY = 'collabbox-doc-types';
const HARVEST = join(ROOT, 'exports', 'collabbox', 'merged-2026-09-28', 'orders', 'orders_combined.csv');
const FETCH_DIR = join(ROOT, 'exports', 'collabbox');
const TYPE_RE = /^[0-9]{3,8}$/;
const DOC_RE = /^[0-9]{3}-[0-9]{4}-[0-9]+\/[0-9]{4}$/;

/**
 * DocNumber → { type, source: 'fetch' | 'harvest' } or { ambiguous: [types] }.
 * Pure over the file contents (exported for review harnesses).
 */
export function resolveTypes({ harvestRows = [], fetches = [] }) {
  const harvest = new Map();
  for (const r of harvestRows) {
    const doc = String(r.DocNumber ?? '').trim();
    const t = String(r.TipID ?? '').trim();
    if (!doc || !TYPE_RE.test(t)) continue;
    (harvest.get(doc) ?? harvest.set(doc, new Set()).get(doc)).add(t);
  }
  const fetched = new Map();
  for (const f of [...fetches].sort((a, b) => String(a.fetchedAt).localeCompare(String(b.fetchedAt)))) {
    for (const h of f.headers || []) {
      const doc = String(h.docNumber ?? '').trim();
      const t = String(h.typeId ?? '').trim();
      if (doc && TYPE_RE.test(t)) fetched.set(doc, t);   // later fetch wins
    }
  }
  const out = new Map();
  for (const [doc, t] of fetched) out.set(doc, { type: t, source: 'fetch', harvest: harvest.has(doc) ? [...harvest.get(doc)] : [] });
  for (const [doc, set] of harvest) {
    if (out.has(doc)) continue;
    out.set(doc, set.size === 1 ? { type: [...set][0], source: 'harvest' } : { ambiguous: [...set].sort() });
  }
  return out;
}

/** What --apply would write, and what it leaves alone (pure). */
export function planDocTypes(orders, types) {
  const plan = [];
  const skipped = [];
  const counts = { orders: orders.length, already_typed: 0, already_same: 0, differs: 0, to_write: 0, unknown: 0, ambiguous: 0, bad_doc_number: 0 };
  const byType = {};
  for (const o of orders) {
    const doc = String(o.external_order_id ?? '').trim();
    const r = types.get(doc);
    if (o.collabbox_doc_type) {
      counts.already_typed++;
      if (r?.type && r.type !== o.collabbox_doc_type) {
        counts.differs++;
        skipped.push({ order_id: o.id, display_id: o.display_id, doc_number: doc, why: 'stored_type_differs', stored: o.collabbox_doc_type, files: r.type });
      } else counts.already_same++;
      continue;
    }
    if (!r) {
      if (!DOC_RE.test(doc)) counts.bad_doc_number++; else counts.unknown++;
      skipped.push({ order_id: o.id, display_id: o.display_id, doc_number: doc, why: DOC_RE.test(doc) ? 'type_unknown' : 'not_a_doc_number' });
      continue;
    }
    if (r.ambiguous) {
      counts.ambiguous++;
      skipped.push({ order_id: o.id, display_id: o.display_id, doc_number: doc, why: 'ambiguous', files: r.ambiguous.join('|') });
      continue;
    }
    counts.to_write++;
    byType[r.type] = (byType[r.type] || 0) + 1;
    plan.push({ id: o.id, type: r.type, source: r.source, doc, sale_source: o.sale_source, detail: o.sale_source_detail });
  }
  return { plan, skipped, counts, byType };
}

export function buildChunkSql(rows) {
  const vals = rows.map((r) => `(${qUuid(r.id)}, ${q(r.type)})`).join(',\n');
  return `
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '10s';
with v(id, t) as (values
${vals}
), u as (
  update public.orders o
     set collabbox_doc_type = v.t
    from v
   where o.id = v.id
     and o.external_source = 'collabbox'
     and o.collabbox_doc_type is null
  returning 1
)
select (select count(*) from v)::int as planned, (select count(*) from u)::int as applied;`;
}

function loadFetches() {
  const out = [];
  for (const f of readdirSync(FETCH_DIR).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const j = JSON.parse(readFileSync(join(FETCH_DIR, f), 'utf8'));
      if (Array.isArray(j.headers)) out.push({ file: f, fetchedAt: j.meta?.fetchedAt ?? f, headers: j.headers });
    } catch { warn(`${f}: not a collabbox-fetch file — ignored`); }
  }
  return out;
}

async function loadOrders(hasCol) {
  const out = [];
  let last = null;
  for (;;) {
    const rows = await sqlRead(`select o.id, o.display_id, o.external_order_id, o.sale_source, o.sale_source_detail,
          ${hasCol ? 'o.collabbox_doc_type' : 'null::text as collabbox_doc_type'}
        from public.orders o
       where o.external_source = 'collabbox' and o.external_order_id is not null
         ${last ? `and o.id > ${qUuid(last)}` : ''}
       order by o.id limit 20000`);
    out.push(...rows);
    if (rows.length < 20000) break;
    last = rows[rows.length - 1].id;
  }
  return out;
}

/** (current source/detail) → (department by type), for the owner — read through THE function. */
async function departmentDrift(plan) {
  const combos = new Map();
  for (const p of plan) {
    const series = p.doc.split('-')[1] ?? '';
    const k = `${p.type}|${series}|${p.sale_source ?? ''}|${p.detail ?? ''}`;
    combos.set(k, (combos.get(k) || 0) + 1);
  }
  if (!combos.size) return [];
  const vals = [...combos.keys()].map((k) => {
    const [t, s, src, det] = k.split('|');
    return `(${q(t)}, ${q(`002-${s}-1/2026`)}, ${q(src)}, ${q(det)})`;
  }).join(',');
  const rows = await sqlRead(`select v.t, v.doc, v.src, v.det, public.collabbox_department(v.t, v.doc, null::uuid, null::timestamptz) as dept
      from (values ${vals}) v(t, doc, src, det)`);
  const drift = {};
  for (const r of rows) {
    const series = r.doc.split('-')[1];
    const n = combos.get(`${r.t}|${series}|${r.src}|${r.det}`) || 0;
    const to = Array.isArray(r.dept) ? r.dept.join('/') : String(r.dept ?? '(classifier)').replace(/[{}]/g, '').replace(',', '/');
    const from = `${r.src || '-'}/${r.det || '-'}`;
    if (from === to) continue;
    const key = `${from} → ${to} (type ${r.t})`;
    drift[key] = (drift[key] || 0) + n;
  }
  return Object.entries(drift).sort((a, b) => b[1] - a[1]).map(([move, orders]) => ({ move, orders }));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'outside-quiet-window', 'help'], values: ['chunk'] });
  if (args.help) { console.log('usage: see the header of scripts/backfill-collabbox-doc-types.mjs'); return; }
  const APPLY = !!args.apply;
  mkGuard();
  console.log(bold(`\nBackfill — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();

  const [pre] = await sqlRead(`select
      exists (select 1 from information_schema.columns
               where table_schema = 'public' and table_name = 'orders' and column_name = 'collabbox_doc_type') as has_col,
      to_regprocedure('public.collabbox_department(text,text,uuid,timestamptz)') is not null as has_dept`);
  if (!pre.has_col) {
    const msg = 'orders.collabbox_doc_type does not exist — apply supabase/migrations/20260942000900_collabbox_nightly_sync.sql first';
    if (APPLY) die(msg);
    warn(`${msg} (the dry run treats every order as untyped)`);
  }

  if (!existsSync(HARVEST)) die(`missing ${HARVEST}`);
  const harvestRows = csvObjects(readFileSync(HARVEST, 'utf8'));
  const fetches = loadFetches();
  const types = resolveTypes({ harvestRows, fetches });
  ok(`types known locally: ${types.size.toLocaleString('de-DE')} documents (harvest ${harvestRows.length.toLocaleString('de-DE')} rows, ${fetches.length} fetch files)`);

  const orders = await loadOrders(pre.has_col);
  ok(`collabBox orders: ${orders.length.toLocaleString('de-DE')}`);
  const { plan, skipped, counts, byType } = planDocTypes(orders, types);
  printTable([counts]);
  printTable(Object.entries(byType).sort((a, b) => b[1] - a[1]).map(([type, n]) => ({ type, orders: n })));

  if (pre.has_dept) {
    const drift = await departmentDrift(plan);
    console.log(bold('\nDepartment by TYPE vs the stored source (information — this script never moves a source):'));
    if (drift.length) printTable(drift); else ok('every order already sits in its type\'s department');
  } else {
    warn('collabbox_department(type, doc, person, at) is not live yet — the department drift shows after the migration');
  }

  if (skipped.length) {
    const path = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, skipped,
      ['order_id', 'display_id', 'doc_number', 'why', 'stored', 'files']);
    ok(`not written (listed, PII-free): ${skipped.length} → ${path}`);
  }

  if (!APPLY) {
    console.log(yellow(`\nDry run — nothing written. ${counts.to_write.toLocaleString('de-DE')} orders would get their type.`));
    console.log('  Apply in the quiet window (after 20:55 Skopje):');
    console.log('    node scripts/assert-mk-target.mjs');
    console.log('    node scripts/backfill-collabbox-doc-types.mjs --apply\n');
    return;
  }

  await requireKeepUpdatedAt({ forApply: true });
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the backfill');
  const size = Math.max(100, Math.min(5000, Number(args.chunk) || 2000));
  let applied = 0;
  for (let i = 0; i < plan.length; i += size) {
    if (i && (i / size) % 10 === 0) await requireNoSegmentRecompute('continue the backfill');
    const [r] = await sql(buildChunkSql(plan.slice(i, i + size)));
    applied += r.applied;
    console.log(`  chunk ${i / size + 1}/${Math.ceil(plan.length / size)}: ${r.applied}/${r.planned}`);
  }
  const [left] = await sqlRead(`select count(*)::int as n from public.orders
      where external_source = 'collabbox' and external_order_id is not null and collabbox_doc_type is null`);
  ok(`${green(applied.toLocaleString('de-DE'))} orders typed; ${left.n.toLocaleString('de-DE')} collabBox orders still without a type (listed in the CSV)`);
  console.log(yellow('  Next: the department reclass (scripts/reclass-by-folder.mjs) reads the same files; nothing else moved.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
