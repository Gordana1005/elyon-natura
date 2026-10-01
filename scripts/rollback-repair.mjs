#!/usr/bin/env node
/**
 * Roll back one applied data-repair run (repair-mex-ghost-links / repair-altercpa-catchup-paid /
 * repair-cod-price / link-lead-parcels — the backfill AND every nightly cron apply of
 * public.link_lead_parcels(), whose ledger rows are written in the same snapshot shape, migration
 * 20260944000950). A collabbox-recredit run is undone by `scripts/collabbox-recredit.mjs --rollback <run>`.
 * A repair-test-phones run is undone by its own
 * `node scripts/repair-test-phones.mjs --restore <run>` (the orders are gone — they are
 * re-inserted from the snapshot, not updated back).
 *
 * cod-price runs (key 'cod-price'): an order goes back to its `before` price, quantity and
 * order_items lines ONLY while those three still equal `after` — its status and MEX facts may
 * have moved on since (MEX decides them; the repair never changed them). See
 * buildPriceRollbackSql in scripts/lib/cod-price.mjs.
 *
 * For every order the run changed (data_repair_rows with `after`), the order is restored to
 * `before` ONLY if it still equals `after` — anything that moved on since (an agent, a cron,
 * MEX) is left alone and reported. The MEX register rows the repair relinked go back the
 * same way (only where they still equal `after`). Everything happens under
 * SET LOCAL elyon.bulk_repair = 'on', in ≤ 200-order transactions that keep a repair unit
 * (a ghost and the real order that got its parcel) together.
 *
 * The rollback is itself recorded: a data_repair_runs row with key "rollback-<key>"
 * (applied), data_repair_rows before/after per order, an order_history row wherever the
 * status goes back, one order_notes row per order and one audit_log row.
 *
 *   node scripts/rollback-repair.mjs --run <id>                     # preview (default): what would be restored / skipped
 *   node scripts/rollback-repair.mjs --run <id> --apply [--actor mile@elyon.com] [--chunk 200]
 *   --only ORD-1,ORD-2   restrict to these orders (their whole units come along)
 *   --loose              compare only status, timestamps, reasons, tracking id and paid_basis — not the
 *                        mex_* facts, which the MEX cron legitimately refreshes after a repair
 *
 * Known limit: if a paid_basis trigger re-derives the basis when a row goes back to paid
 * (e.g. 'manual' for NULL), the restored row carries that instead of the old NULL.
 *
 * 🛑 Macedonia only (repair-kit guards). Run in the quiet window, after assert-mk-target.
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  MK_REF, MAX_CHUNK, SNAP_COLUMNS, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  q, qUuid, qUuidArray, qJson, parseArgs, fmtSkopje, fileStamp, writeCsv, candidateHash, planLine,
  resolveActor, snapshotSql, orderSnapshotSql, printTable, isUuid, requireKeepUpdatedAt, requireNoSegmentRecompute,
} from './lib/repair-kit.mjs';
import { KEY as COD_PRICE_KEY, PRICE_KEYS, priceSnapshotSql, buildPriceRollbackSql } from './lib/cod-price.mjs';
import { KEY as TEST_PHONES_KEY } from './lib/test-phones.mjs';

/** What --loose still compares. */
const CORE = ['status', 'paid_at', 'returned_at', 'shipped_at', 'cancelled_at', 'trashed_at',
  'cancellation_reason', 'trash_reason', 'mex_tracking_id', 'paid_basis'];

const TS_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/;
/** order_items lines → one comparable string (numbers compared as numbers). */
const itemsKey = (xs) => (Array.isArray(xs) ? xs : []).map((i) => `${i.id}:${Number(i.quantity)}:${Number(i.price_per_unit)}:${Number(i.total_price)}`).sort().join('|');
function sameValue(a, b) {
  if (Array.isArray(a) || Array.isArray(b)) return itemsKey(a) === itemsKey(b);
  if ((a ?? null) === null || (b ?? null) === null) return (a ?? null) === (b ?? null);
  if (typeof a === 'string' && typeof b === 'string' && TS_RE.test(a) && TS_RE.test(b)) return Date.parse(a) === Date.parse(b);
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b);
  return String(a) === String(b);
}
export function diffKeys(now, after, keys) {
  return keys.filter((k) => !sameValue(now?.[k], after?.[k]));
}

async function loadRows(runId, { price = false } = {}) {
  return sqlRead(`select r.id, r.order_id, r.rule, r.before, r.after, r.evidence, o.display_id,
      ${price ? priceSnapshotSql('o') : orderSnapshotSql('o')} as now_snap
    from public.data_repair_rows r join public.orders o on o.id = r.order_id
   where r.run_id = ${qUuid(runId)} and r.after is not null
   order by o.display_id`);
}

/** One implicit transaction per API call — no explicit BEGIN/COMMIT (see buildChunkSql in the kit). */
export function buildRollbackSql({ key, runId, rbRunId, orderIds, loose, typeMap }) {
  const actor = `System (rollback:${key})`;
  const cast = (col, src) => {
    const t = typeMap[col];
    if (!t) throw new Error(`orders.${col} does not exist`);
    return `(${src}->>'${col}')::${t}`;
  };
  const nonStatus = SNAP_COLUMNS.filter((c) => c !== 'status');
  const compare = loose
    ? `jsonb_build_object(${CORE.map((c) => `'${c}', o.${c}`).join(', ')})
         = (select coalesce(jsonb_object_agg(k, b.after->k), '{}'::jsonb) from unnest(${`ARRAY[${CORE.map(q).join(',')}]`}) k)`
    : `${orderSnapshotSql('o')} = (b.after - 'parcels')`;
  const parcelWhere = `mp.tracking_id in (select x->>'tracking_id' from jsonb_array_elements(e.before->'parcels') x)`;
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _rb on commit drop as
select r.id as row_id, r.order_id, r.rule, r.before, r.after
  from public.data_repair_rows r
 where r.run_id = ${qUuid(runId)} and r.after is not null and r.order_id = any(${qUuidArray(orderIds)});

select count(*) from (select 1 from public.orders where id in (select order_id from _rb) for update) l;
select count(*) from (select 1 from public.mex_parcels where tracking_id in
  (select x->>'tracking_id' from _rb, jsonb_array_elements(_rb.before->'parcels') x) for update) l;

create temp table _eq on commit drop as
select b.* from _rb b join public.orders o on o.id = b.order_id where ${compare};

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(rbRunId)}, e.order_id, 'rollback:' || e.rule, ${snapshotSql('o', parcelWhere)},
       jsonb_build_object('rolled_back_run', ${q(runId)}, 'line', e.order_id::text || ':rollback:' || coalesce(e.before->>'status', '') || ':')
  from _eq e join public.orders o on o.id = e.order_id;

create temp table _moves on commit drop as
select e.order_id, o.status::text as from_status, e.before->>'status' as to_status
  from _eq e join public.orders o on o.id = e.order_id
 where o.status::text is distinct from e.before->>'status';

-- tracking ids that change are cleared first, so no parcel sits on two orders mid-way
update public.orders o set mex_tracking_id = null
  from _eq e
 where o.id = e.order_id and o.mex_tracking_id is not null
   and o.mex_tracking_id is distinct from (e.before->>'mex_tracking_id');

update public.orders o set status = ${cast('status', 'e.before')}
  from _eq e
 where o.id = e.order_id and o.status::text is distinct from e.before->>'status';

-- every other column, without touching status (so the NULL-only timestamp triggers stay quiet)
update public.orders o set ${nonStatus.map((c) => `${c} = ${cast(c, 'e.before')}`).join(', ')}
  from _eq e where o.id = e.order_id;

update public.mex_parcels mp
   set order_id = nullif(bp->>'order_id', '')::uuid, link_method = bp->>'link_method', linked_at = (bp->>'linked_at')::timestamptz
  from _eq e
       cross join lateral jsonb_array_elements(e.before->'parcels') bp
       join lateral jsonb_array_elements(e.after->'parcels') ap on ap->>'tracking_id' = bp->>'tracking_id'
 where mp.tracking_id = bp->>'tracking_id'
   and mp.order_id is not distinct from nullif(ap->>'order_id', '')::uuid;

insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
select m.order_id, m.from_status::public.order_status, m.to_status::public.order_status, null, ${q(actor)} from _moves m;

insert into public.order_notes (order_id, text, author_id, author_name)
select e.order_id, ${q(`Rollback of repair ${key} (run ${String(runId).slice(0, 8)}): this order was put back to its state from before that repair.`)}, null, ${q(actor)}
  from _eq e;

update public.data_repair_rows r set after = ${snapshotSql('o', parcelWhere)}
  from _eq e join public.orders o on o.id = e.order_id
 where r.run_id = ${qUuid(rbRunId)} and r.order_id = e.order_id and r.after is null;

select (select count(*) from _rb)::int as candidates, (select count(*) from _eq)::int as restored,
       (select count(*) from _moves)::int as status_moves,
       (select coalesce(jsonb_agg(b.order_id), '[]'::jsonb) from _rb b
         where not exists (select 1 from _eq e where e.order_id = b.order_id)) as skipped;`;
}

const USAGE = `usage: node scripts/rollback-repair.mjs --run <id> [--apply] [--only ORD-1,ORD-2] [--loose] [--actor <email>] [--chunk 200]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'loose', 'help'], values: ['run', 'only', 'actor', 'chunk'] });
  if (args.help) { console.log(USAGE); return; }
  if (!args.run || !isUuid(args.run)) die(USAGE);
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRollback of repair run ${args.run} — ${APPLY ? 'APPLY' : 'PREVIEW'}${args.loose ? ' (loose)' : ''}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });

  const [run] = await sqlRead(`select r.id, r.key, r.applied_at, r.created_at,
      (select count(*)::int from public.data_repair_rows x where x.run_id = r.id and x.after is not null) as changed
    from public.data_repair_runs r where r.id = ${qUuid(args.run)}`);
  if (!run) die(`run ${args.run} not found.`);
  const key = run.key;
  if (!/^[a-z0-9-]+$/.test(key)) die(`unexpected run key ${key}`);
  if (key === TEST_PHONES_KEY) {
    die(`run ${args.run} deleted orders — they are brought back from its snapshot, not rolled back:\n` +
      `  node scripts/repair-test-phones.mjs --restore ${args.run}          (preview)\n` +
      `  node scripts/repair-test-phones.mjs --restore ${args.run} --apply`);
  }
  if (key === `restore-${TEST_PHONES_KEY}`) {
    die(`run ${args.run} restored deleted orders; to delete them again, dry-run repair-test-phones.mjs anew and apply that run.`);
  }
  if (key === 'collabbox-recredit' || key === 'rollback-collabbox-recredit') {
    // Its ledger snapshots sold_* + the collabBox document row, not SNAP_COLUMNS — it has its own rollback.
    die(`run ${args.run} is a collabBox credit re-run:\n  node scripts/collabbox-recredit.mjs --rollback ${args.run}          (preview)\n` +
      `  node scripts/collabbox-recredit.mjs --rollback ${args.run} --apply`);
  }
  if (key === 'open-order-zones' || key === 'rollback-open-order-zones') {
    // Its ledger snapshots the zone columns, not SNAP_COLUMNS — it has its own rollback.
    die(`run ${args.run} is a MEX-zone repair:\n  node scripts/repair-open-order-zones.mjs --rollback ${args.run}          (preview)\n` +
      `  node scripts/repair-open-order-zones.mjs --rollback ${args.run} --apply`);
  }
  const PRICE = key === COD_PRICE_KEY || key === `rollback-${COD_PRICE_KEY}`;
  if (PRICE && args.loose) die('--loose does not apply to a cod-price run (it already compares only price, quantity and order_items).');
  if (APPLY) {
    await requireKeepUpdatedAt({ forApply: true });
    await requireNoSegmentRecompute('start the rollback');
  }
  if (key.startsWith('rollback-')) warn('this run is itself a rollback — rolling it back re-applies the original repair.');
  const state = run.applied_at ? `applied ${fmtSkopje(run.applied_at)}`
    : run.changed ? yellow(`${run.changed} orders changed but never finalized — an apply stopped part-way`)
    : 'a dry run that was never applied';
  console.log(`  run key ${key} · created ${fmtSkopje(run.created_at)} · ${state}`);

  const rows = await loadRows(args.run, { price: PRICE });
  if (!rows.length) die('this run changed no orders — nothing to roll back.');
  const keys = PRICE ? PRICE_KEYS : args.loose ? CORE : SNAP_COLUMNS;
  const only = new Set(String(args.only || '').split(',').map((s) => s.trim()).filter(Boolean));
  const unitOf = (r) => r.evidence?.unit || r.order_id;
  const wantedUnits = only.size ? new Set(rows.filter((r) => only.has(r.display_id)).map(unitOf)) : null;
  const scope = wantedUnits ? rows.filter((r) => wantedUnits.has(unitOf(r))) : rows;
  if (!scope.length) die('--only matched no order of this run.');

  const preview = scope.map((r) => {
    const diff = diffKeys(r.now_snap, r.after, keys);
    return PRICE
      ? { order: r.display_id, rule: r.rule, now: `${r.now_snap?.price} €`, back_to: `${r.before?.price} €`, restorable: diff.length ? 'no' : 'yes', changed_since: diff.join(' ') }
      : { order: r.display_id, rule: r.rule, now: r.now_snap?.status, back_to: r.before?.status, restorable: diff.length ? 'no' : 'yes', changed_since: diff.join(' ') };
  });
  const restorable = preview.filter((p) => p.restorable === 'yes');
  const skipped = preview.filter((p) => p.restorable === 'no');
  console.log(bold('Preview'));
  printTable(Object.entries(preview.reduce((m, p) => { const k = `${p.rule}: ${p.now} → ${p.back_to}`; m[k] = (m[k] || 0) + 1; return m; }, {}))
    .map(([move, n]) => ({ move, orders: n })));
  console.log(`  restorable: ${restorable.length} · changed since the repair (left alone): ${skipped.length}`);
  for (const s of skipped.slice(0, 50)) console.log(`    ${s.order.padEnd(11)} ${s.changed_since}`);
  if (skipped.length > 50) console.log(`    … ${skipped.length - 50} more in the CSV`);
  const csvPath = writeCsv(`rollback-${key}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, preview);
  ok(`CSV: ${csvPath}`);
  if (!APPLY) {
    console.log(`\nPreview only — nothing written. To restore: node scripts/rollback-repair.mjs --run ${args.run} --apply${args.loose ? ' --loose' : ''}${args.only ? ` --only ${args.only}` : ''}\n`);
    return;
  }

  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const typeMap = await loadOrderColumnTypes();
  const rbKey = `rollback-${key}`.slice(0, 60);
  const rbRunId = randomUUID();
  const lines = scope.map((r) => planLine(r.order_id, 'rollback', PRICE ? r.before?.price : r.before?.status, ''));
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary, created_at)
    values (${qUuid(rbRunId)}, ${q(rbKey)}, false, ${q(candidateHash(lines))},
            ${qJson({ rolled_back_run: args.run, loose: !!args.loose, only: [...only], orders_in_scope: scope.length })}, now())`);
  ok(`rollback recorded as run ${rbRunId}`);

  // chunks that keep repair units together
  const units = new Map();
  for (const r of scope) (units.get(unitOf(r)) ?? units.set(unitOf(r), []).get(unitOf(r))).push(r.order_id);
  const size = Math.max(1, Math.min(MAX_CHUNK, Number(args.chunk) || MAX_CHUNK));
  const chunks = [];
  let cur = [];
  for (const ids of units.values()) {
    if (cur.length + ids.length > size && cur.length) { chunks.push(cur); cur = []; }
    cur.push(...ids);
  }
  if (cur.length) chunks.push(cur);

  const stats = { restored: 0, moves: 0, skipped: [], failed: null };
  for (let i = 0; i < chunks.length; i++) {
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${chunks[i].length} orders) … `);
    try {
      const [res] = await sql(PRICE
        ? buildPriceRollbackSql({ key, runId: args.run, rbRunId, orderIds: chunks[i] })
        : buildRollbackSql({ key, runId: args.run, rbRunId, orderIds: chunks[i], loose: !!args.loose, typeMap }));
      stats.restored += res.restored;
      stats.moves += res.status_moves;
      stats.skipped.push(...(res.skipped || []));
      console.log(`${green('committed')} ${res.restored}/${res.candidates} restored`);
    } catch (e) {
      console.log('FAILED — rolled back');
      stats.failed = { chunk: i + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(stats.failed.error);
      break;
    }
  }
  const payload = { rolled_back_run: args.run, key, restored: stats.restored, status_moves: stats.moves, skipped: stats.skipped.length, failed: stats.failed, loose: !!args.loose };
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
           summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${qJson(payload)})
     where id = ${qUuid(rbRunId)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, ${q(stats.failed ? 'data_repair.rollback_partial' : 'data_repair.rollback')},
            'data_repair_run', ${q(args.run)}, ${q(key)}, ${qJson(payload)});`);
  if (stats.failed) die(`stopped at chunk ${stats.failed.chunk}; earlier chunks are committed. Re-run to continue (already restored rows no longer equal "after" and are skipped).`);
  ok(`restored ${stats.restored} orders (${stats.moves} status changes); ${stats.skipped.length} changed since the repair and were left alone.`);
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
