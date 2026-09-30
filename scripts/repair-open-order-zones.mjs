/**
 * Repair — the MEX zone of OPEN orders (Phase 7, plan 30.09; migrations 20260943000500–0700).
 * No shebang: keep it importable by a test. Run with `node`.
 *
 * Until 30.09 the zone came from a name match with LIMIT 1 and no ORDER BY: 290 of 295 Skopje
 * sales went to "Skopje - Centar", and same-named places went to another town (Прилеп's
 * "Центар" → "Skopje - Centar"). Orders still OPEN — no MEX parcel yet — can be corrected;
 * a parcel's zone is final (MEX has no cancel / re-route endpoint), so those are never touched.
 *
 * public.open_order_zone_candidates() re-resolves every open home order (pending / take /
 * call_again / confirmed / duplicated, no parcel, not packed) with the ONE resolver and classes
 * it: same · district_fix · cross_city_fix · needs_pick · unmapped. ONLY district_fix and
 * cross_city_fix are ever applied; needs_pick (an ambiguous name, or Skopje with no
 * neighbourhood) waits for a person in the new order form, unmapped stays held back by the export.
 *
 *   node scripts/repair-open-order-zones.mjs                       dry run (default): counts per class
 *                                                                  + 20 samples each, CSV in
 *                                                                  exports/repairs/ (PII, gitignored),
 *                                                                  a data_repair_runs row (dry_run,
 *                                                                  candidate_hash) → prints the run id
 *   node scripts/repair-open-order-zones.mjs --no-record           the same, but writes NOTHING
 *                                                                  (no CSV, no run row)
 *   node scripts/repair-open-order-zones.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 500]
 *        [--outside-quiet-window]
 *   node scripts/repair-open-order-zones.mjs --rollback <run> [--apply] [--actor …]
 *
 * APPLY: re-classify; refuse unless the hash equals the dry run's; then ≤ 500-order
 * transactions, each: SET LOCAL elyon.keep_updated_at = 'on' (orders.updated_at is Call Again's
 * last_call_at — a repair must never look like a call), lock the orders, keep only those still
 * open with no parcel and the SAME zone as reviewed, data_repair_rows.before → UPDATE
 * mex_city_id / mex_city_name / settlement_id, mex_zone_basis = 'repair' (re-checking
 * mex_tracking_id IS NULL in the UPDATE itself) → data_repair_rows.after. Then applied_at + one
 * audit_log row. Quiet window (20:55–07:00 Skopje) and "no segment recompute running" are
 * enforced like every repair (scripts/lib/repair-kit.mjs).
 *
 * ROLLBACK: every order of the run whose zone columns still equal `after` goes back to `before`
 * (the rest moved on — an agent re-picked, a parcel appeared — and is reported, never
 * overwritten). Recorded as run key "rollback-open-order-zones". Preview by default.
 *
 * 🛑 Macedonia only (repair-kit guards). Status, money, stock and MEX links are never touched.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  segmentRecomputeActivity, q, qUuid, qJson, parseArgs, fileStamp, writeCsv, planLine, candidateHash, isUuid,
  resolveActor, recordDryRun, verifyRunForApply, finalizeRun, auditPartial, fmtSkopje,
} from './lib/repair-kit.mjs';

export const KEY = 'open-order-zones';
export const ROLLBACK_KEY = `rollback-${KEY}`;
export const APPLY_CLASSES = Object.freeze(['district_fix', 'cross_city_fix']);
export const ALL_CLASSES = Object.freeze(['same', 'district_fix', 'cross_city_fix', 'needs_pick', 'unmapped']);
export const MAX_CHUNK = 500;
const OPEN = `('pending', 'take', 'call_again', 'confirmed', 'duplicated')`;
const ZONE_COLS = ['mex_city_id', 'mex_city_name', 'settlement_id', 'mex_zone_basis'];

// ─── pure helpers (exported for tests) ──────────────────────────────────────
/** The hashed line for a candidate — order, rule, target zone, and the zone it had. */
export const lineFor = (c) => planLine(c.order_id, c.class, `${c.new_zone ?? ''}/${c.new_settlement_id ?? ''}`, String(c.old_zone ?? ''));
export const actionable = (rows) => rows.filter((r) => APPLY_CLASSES.includes(r.class));
export function countByClass(rows) {
  const out = Object.fromEntries(ALL_CLASSES.map((k) => [k, 0]));
  for (const r of rows) out[r.class] = (out[r.class] ?? 0) + 1;
  return out;
}
export const sampleLine = (r) =>
  `${r.display_id}  ${r.status.padEnd(10)} ${String(r.customer_city || '∅')}${r.quarter ? ` · ${r.quarter}` : ''}` +
  `  ${r.old_zone_name || '∅'} → ${r.new_zone_name || '∅'}` +
  `${r.new_city ? `  (${r.new_city}${r.new_district ? ` / ${r.new_district}` : ''})` : ''}` +
  `${r.match === 'ambiguous' && Array.isArray(r.candidates) ? `  [${r.candidates.length} places]` : ''}`;

/** One ≤ 500-order transaction (one Management API call = one implicit transaction). */
export function buildApplyChunkSql({ runId, rows }) {
  const values = rows.map((r) => `(${[
    qUuid(r.order_id), q(r.class), r.old_zone == null ? 'NULL::int' : `${Number(r.old_zone)}::int`,
    `${Number(r.new_zone)}::int`, q(r.new_zone_name), q(r.new_settlement_id ?? null),
    qJson({ line: lineFor(r), city: r.customer_city, quarter: r.quarter, match: r.match, new_city: r.new_city, new_district: r.new_district }),
  ].join(', ')})`);
  const snap = (o) => `jsonb_build_object(${ZONE_COLS.map((c) => `'${c}', ${o}.${c}`).join(', ')}, 'mex_tracking_id', ${o}.mex_tracking_id)`;
  return `
set local elyon.keep_updated_at = 'on';
set local elyon.bulk_repair = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';

create temp table _plan (
  order_id uuid primary key, rule text not null, expect_zone int, new_zone int not null,
  new_zone_name text, new_settlement text, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

select count(*) from (select 1 from public.orders where id in (select order_id from _plan) for update) l;

-- only orders still open, without a parcel, and on the zone that was reviewed
create temp table _ok on commit drop as
select p.* from _plan p join public.orders o on o.id = p.order_id
 where o.status::text in ${OPEN}
   and o.mex_tracking_id is null and o.packed_at is null
   and coalesce(o.delivery_type, 'home') = 'home'
   and o.mex_city_id is not distinct from p.expect_zone
   and exists (select 1 from public.mex_cities z where z.city_id = p.new_zone and z.is_active and z.is_duplicate_of is null);

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, k.order_id, k.rule, ${snap('o')}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;

update public.orders o
   set mex_city_id = k.new_zone,
       mex_city_name = k.new_zone_name,
       settlement_id = coalesce(k.new_settlement, o.settlement_id),
       mex_zone_basis = 'repair'
  from _ok k
 where o.id = k.order_id and o.mex_tracking_id is null;

update public.data_repair_rows r set after = ${snap('o')}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

/** Restore `before` where the order still equals `after` (and has no parcel). */
export function buildRollbackChunkSql({ sourceRunId, rollbackRunId, orderIds }) {
  const snap = (o) => `jsonb_build_object(${ZONE_COLS.map((c) => `'${c}', ${o}.${c}`).join(', ')}, 'mex_tracking_id', ${o}.mex_tracking_id)`;
  return `
set local elyon.keep_updated_at = 'on';
set local elyon.bulk_repair = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';

create temp table _src on commit drop as
select r.order_id, r.before, r.after from public.data_repair_rows r
 where r.run_id = ${qUuid(sourceRunId)} and r.after is not null
   and r.order_id = any(ARRAY[${orderIds.map(qUuid).join(',')}]::uuid[]);

select count(*) from (select 1 from public.orders where id in (select order_id from _src) for update) l;

create temp table _ok on commit drop as
select s.* from _src s join public.orders o on o.id = s.order_id
 where o.mex_tracking_id is null
   and o.mex_city_id is not distinct from (s.after->>'mex_city_id')::int
   and o.settlement_id is not distinct from s.after->>'settlement_id'
   and o.mex_zone_basis is not distinct from s.after->>'mex_zone_basis';

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(rollbackRunId)}, k.order_id, 'rollback', ${snap('o')}, jsonb_build_object('source_run', ${q(sourceRunId)})
  from _ok k join public.orders o on o.id = k.order_id;

update public.orders o
   set mex_city_id = (k.before->>'mex_city_id')::int,
       mex_city_name = k.before->>'mex_city_name',
       settlement_id = k.before->>'settlement_id',
       mex_zone_basis = k.before->>'mex_zone_basis'
  from _ok k
 where o.id = k.order_id and o.mex_tracking_id is null;

update public.data_repair_rows r set after = ${snap('o')}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(rollbackRunId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _src)::int as planned,
       (select count(*) from _ok)::int as restored,
       (select coalesce(jsonb_agg(s.order_id), '[]'::jsonb) from _src s
         where not exists (select 1 from _ok k where k.order_id = s.order_id)) as skipped;`;
}

// ─── IO ─────────────────────────────────────────────────────────────────────
async function requireSchema() {
  const [s] = await sqlRead(`select
      to_regprocedure('public.open_order_zone_candidates()') is not null as candidates,
      to_regclass('public.data_repair_runs') is not null as runs,
      (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'orders'
         and column_name in ('settlement_id', 'mex_zone_basis')) as cols`);
  if (!s?.candidates || !s.runs || s.cols < 2) {
    die('Not applied yet — apply 20260943000500, 20260943000600 and 20260943000700 first (and 20260934000200 for the ledger).');
  }
}

export const CANDIDATES_SQL = `select order_id, display_id, status, created_at, customer_city, quarter,
    old_zone, old_zone_name, old_settlement_id, old_basis, new_zone, new_zone_name, new_settlement_id,
    new_city, new_district, new_basis, match, candidates, class
  from public.open_order_zone_candidates() order by created_at desc, order_id`;

async function loadCandidates() {
  const rows = await sqlRead(CANDIDATES_SQL);
  return rows.map((r) => ({ ...r, candidates: typeof r.candidates === 'string' ? JSON.parse(r.candidates) : r.candidates }));
}

function printClasses(rows) {
  const counts = countByClass(rows);
  console.log(bold(`\n${rows.length} open home orders without a MEX parcel`));
  for (const k of ALL_CLASSES) {
    const tag = APPLY_CLASSES.includes(k) ? green('  ← applied') : k === 'needs_pick' ? yellow('  ← a person picks in the order form') : '';
    console.log(`  ${k.padEnd(15)} ${String(counts[k]).padStart(5)}${tag}`);
  }
  for (const k of ALL_CLASSES) {
    const list = rows.filter((r) => r.class === k);
    if (!list.length) continue;
    console.log(bold(`\n${k} — ${Math.min(20, list.length)} of ${list.length}`));
    for (const r of list.slice(0, 20)) console.log(`  ${sampleLine(r)}`);
  }
  return counts;
}

async function dryRun({ record }) {
  const rows = await loadCandidates();
  const counts = printClasses(rows);
  const act = actionable(rows);
  if (!record) {
    console.log(yellow('\n--no-record: nothing written (no CSV, no run row).'));
    return;
  }
  const csv = writeCsv(`${KEY}-${fileStamp()}.csv`, rows.map((r) => ({
    order: r.display_id, status: r.status, class: r.class, city: r.customer_city, quarter: r.quarter,
    old_zone: r.old_zone_name, new_zone: r.new_zone_name, new_city: r.new_city, new_district: r.new_district,
    match: r.match, candidates: Array.isArray(r.candidates) ? r.candidates.map((c) => `${c.name}${c.parent_name ? ` · ${c.parent_name}` : c.municipality ? ` · ${c.municipality}` : ''} → ${c.mex_city_name ?? '∅'}`).join(' | ') : '',
    order_id: r.order_id,
  })));
  ok(`CSV: ${csv}`);
  const { id, hash } = await recordDryRun({ key: KEY, lines: act.map(lineFor), summary: { counts, actionable: act.length } });
  ok(`dry run recorded: ${bold(id)} (hash ${hash.slice(0, 12)}…, ${act.length} orders to apply)`);
  console.log(`\nApply (in the quiet window, after node scripts/assert-mk-target.mjs):\n  node scripts/repair-open-order-zones.mjs --apply --run ${id}`);
}

async function apply({ runId, actorEmail, chunk, outside }) {
  await requireKeepUpdatedAt({ forApply: true });
  requireQuietWindow({ override: outside });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(actorEmail);
  const rows = await loadCandidates();
  const act = actionable(rows);
  const { done } = await verifyRunForApply({ key: KEY, runId, lines: act.map(lineFor) });
  const todo = act.filter((r) => !done.has(r.order_id));
  const size = Math.max(1, Math.min(MAX_CHUNK, Number(chunk) || MAX_CHUNK));
  const stats = { planned: 0, applied: 0, skipped: [], chunks: 0, failed: null };
  for (let i = 0; i < todo.length; i += size) {
    const a = await segmentRecomputeActivity();
    if (a.busy > 0) { stats.failed = { chunk: stats.chunks + 1, error: `${a.what} started — stopped` }; break; }
    const part = todo.slice(i, i + size);
    process.stdout.write(`  chunk ${stats.chunks + 1} (${part.length} orders) … `);
    try {
      const [res] = await sql(buildApplyChunkSql({ runId, rows: part }));
      stats.chunks++; stats.planned += res.planned; stats.applied += res.applied;
      const skipped = Array.isArray(res.skipped) ? res.skipped : JSON.parse(res.skipped || '[]');
      stats.skipped.push(...skipped);
      console.log(`${green('committed')} ${res.applied}/${res.planned}${skipped.length ? yellow(` (${skipped.length} moved since the dry run — left alone)`) : ''}`);
    } catch (e) {
      console.log('FAILED — rolled back');
      stats.failed = { chunk: stats.chunks + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(stats.failed.error);
      break;
    }
  }
  const payload = { ...stats, skipped: stats.skipped.length, resumed: done.size };
  if (stats.failed) { await auditPartial({ key: KEY, runId, actor, payload }); die(`stopped: ${stats.failed.error}`); }
  await finalizeRun({ key: KEY, runId, actor, payload });
  ok(`applied ${stats.applied} orders (${stats.skipped.length} left alone) — run ${runId} finalized at ${fmtSkopje(Date.now())}`);
}

async function rollback({ runId, doApply, actorEmail }) {
  if (!isUuid(runId)) die('--rollback needs the run id of an applied open-order-zones run.');
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run) die(`run ${runId} not found.`);
  if (run.key !== KEY) die(`run ${runId} belongs to "${run.key}", not "${KEY}".`);
  const rows = await sqlRead(`select r.order_id, r.before, r.after, o.display_id, o.mex_tracking_id,
      o.mex_city_id, o.settlement_id, o.mex_zone_basis
    from public.data_repair_rows r join public.orders o on o.id = r.order_id
   where r.run_id = ${qUuid(runId)} and r.after is not null order by o.display_id`);
  const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
  const restorable = rows.filter((r) => {
    const a = parse(r.after);
    return !r.mex_tracking_id && String(r.mex_city_id ?? '') === String(a.mex_city_id ?? '')
      && String(r.settlement_id ?? '') === String(a.settlement_id ?? '') && String(r.mex_zone_basis ?? '') === String(a.mex_zone_basis ?? '');
  });
  console.log(bold(`run ${runId}: ${rows.length} orders changed · ${restorable.length} still as the repair left them · ${rows.length - restorable.length} moved on (left alone)`));
  for (const r of restorable.slice(0, 20)) {
    const b = parse(r.before), a = parse(r.after);
    console.log(`  ${r.display_id}  ${a.mex_city_name ?? '∅'} → back to ${b.mex_city_name ?? '∅'}`);
  }
  if (!doApply) { console.log(yellow('\npreview only — add --apply to restore.')); return; }
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(actorEmail);
  const rbId = randomUUID();
  const ids = restorable.map((r) => r.order_id);
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rbId)}, ${q(ROLLBACK_KEY)}, false, ${q(candidateHash(ids))}, ${qJson({ source_run: runId, orders: ids.length })})`);
  let restored = 0, skipped = 0;
  for (let i = 0; i < ids.length; i += MAX_CHUNK) {
    const [res] = await sql(buildRollbackChunkSql({ sourceRunId: runId, rollbackRunId: rbId, orderIds: ids.slice(i, i + MAX_CHUNK) }));
    restored += res.restored;
    skipped += (Array.isArray(res.skipped) ? res.skipped : JSON.parse(res.skipped || '[]')).length;
  }
  await finalizeRun({ key: ROLLBACK_KEY, runId: rbId, actor, payload: { source_run: runId, restored, skipped } });
  ok(`restored ${restored} orders (${skipped} moved on) — rollback run ${rbId}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'no-record', 'dry-run', 'outside-quiet-window'],
    values: ['run', 'actor', 'chunk', 'rollback'],
  });
  mkGuard();
  await assertRemoteIsMk();
  await requireSchema();
  if (args.rollback) return rollback({ runId: args.rollback, doApply: !!args.apply, actorEmail: args.actor || 'mile@elyon.com' });
  if (args.apply) {
    if (!args.run) die('--apply needs --run <id> from a dry run.');
    return apply({ runId: args.run, actorEmail: args.actor || 'mile@elyon.com', chunk: args.chunk, outside: !!args['outside-quiet-window'] });
  }
  if (args.run) warn('--run is ignored without --apply.');
  return dryRun({ record: !args['no-record'] });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((e) => die(String(e?.message || e)));
}
