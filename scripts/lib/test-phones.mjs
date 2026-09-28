/**
 * test-phones — the pure half of scripts/repair-test-phones.mjs.
 *
 * Owner decision 28.09.2026 (HANDOFF §3, law): "Test phones 070123456 and 23123123: DELETE
 * their CRM orders (snapshot first). Exclude their web orders and MEX parcels from all
 * reports; you can't touch the shop."
 *
 *   TEST_PHONES          the two numbers, as last-8 keys (the project's phone canon —
 *                        .grok/skills/elyon-phone-normalization). The database twin for
 *                        reports is public.report_excluded_phones + is_report_excluded_phone()
 *                        (migration 20260940000300); keep the two lists equal.
 *   DEPENDENTS           every table that points at orders(id) — the FK ones with their ON
 *                        DELETE rule (read from the migrations, re-checked live against
 *                        pg_constraint before an apply) and the soft references — and what the
 *                        repair does with each.
 *   classifyTestPhoneOrders()   which orders are deleted and which are only listed.
 *   buildDeleteChunkSql()       ONE transaction: snapshot → unlink → delete.
 *   buildRestoreSql()           ONE transaction: re-insert from the ledger snapshot.
 *
 * No I/O here.
 */
import { MAX_CHUNK, NOW, q, qUuid, qUuidArray, qJson, qTextArray, planLine, toMs, DAY_MS } from './repair-kit.mjs';

export const KEY = 'test-phones';
export const RESTORE_KEY = 'restore-test-phones';

export const TEST_PHONES = Object.freeze([
  { phone8: '70123456', national: '070123456', note: 'Test phone 070123456 — owner decision 28.09.2026: its CRM orders are deleted, its web orders and MEX parcels are excluded from every report.' },
  { phone8: '23123123', national: '023123123', note: 'Test phone 23123123 — owner decision 28.09.2026: its CRM orders are deleted, its web orders and MEX parcels are excluded from every report.' },
]);
export const TEST_PHONE8S = Object.freeze(TEST_PHONES.map((t) => t.phone8));

const digitsOf = (x) => String(x ?? '').replace(/\D/g, '');
/** Last 8 digits, exactly as idx_orders_phone_last8 / the api compute it ('' when < 8 digits). */
export const last8 = (x) => { const d = digitsOf(x); return d.length >= 8 ? d.slice(-8) : ''; };
export const isTestPhone = (x, list = TEST_PHONE8S) => { const k = last8(x); return !!k && list.includes(k); };

/**
 * How a stored phone relates to a test number:
 *   'exact'         a Macedonian spelling of it: 070123456, 70123456, +38970123456,
 *                   0038970123456, 389070123456 (and the same for 023123123)
 *   'other_prefix'  only the last 8 digits agree — e.g. +35970123456 — a different number
 *                   that last-8 matching would conflate; never deleted, listed instead
 *   null            not a test number
 */
export function testNumberForm(phone, list = TEST_PHONE8S) {
  if (!isTestPhone(phone, list)) return null;
  const d = digitsOf(phone).replace(/^00/, '');
  const m = d.match(/^(?:389)?0?(\d{8})$/);
  return m && list.includes(m[1]) ? 'exact' : 'other_prefix';
}

/**
 * Every table that references an order. `fk` is the ON DELETE rule of a real foreign key
 * (null = a soft reference, no FK). `action` is what this repair does:
 *   delete   the rows go with the order (FK CASCADE, or an explicit delete) — snapshotted
 *   unlink   the row stays, its reference is set NULL (never delete the ledger rows) —
 *            snapshotted, and relinked by --restore
 *   engine   prediction_segment_members: the FK sets trigger_order_id NULL, and the
 *            AFTER DELETE trigger's recompute_customer_segments() drops the phone from every
 *            non-static list once it has no order left — the engine owns that table
 *   keep     untouched (history / telemetry that must outlive the order)
 *   block    the order is NOT deleted while such a row exists (listed for a decision)
 * `snapshot`: 'rows' (full to_jsonb rows), 'link' (key + reference), 'ids' (row keys only).
 * Source: the migrations (grep REFERENCES public.orders) — verified live against
 * pg_constraint before every apply (verifyForeignKeys).
 */
export const DEPENDENTS = Object.freeze([
  { table: 'order_items', column: 'order_id', fk: 'CASCADE', action: 'delete', snapshot: 'rows', order: 'x.id', keySql: 'x.id::text', restore: 'reinsert' },
  { table: 'order_history', column: 'order_id', fk: 'CASCADE', action: 'delete', snapshot: 'rows', order: 'x.changed_at, x.id', keySql: 'x.id::text', restore: 'reinsert' },
  { table: 'order_notes', column: 'order_id', fk: 'CASCADE', action: 'delete', snapshot: 'rows', order: 'x.created_at, x.id', keySql: 'x.id::text', restore: 'reinsert' },
  { table: 'order_unpaid_alerts', column: 'order_id', fk: 'CASCADE', action: 'delete', snapshot: 'rows', order: 'x.alert_date', keySql: 'x.alert_date::text', restore: 'reinsert' },
  { table: 'no_parcel_rule_items', column: 'order_id', fk: 'CASCADE', action: 'delete', snapshot: 'rows', order: 'x.run_id', keySql: 'x.run_id::text', restore: 'reinsert (when its run still exists)' },
  { table: 'affiliate_leads', column: 'order_id', fk: 'CASCADE', action: 'block', snapshot: 'rows', order: 'x.id', keySql: 'x.id::text',
    why: 'a partner lead with its payout snapshot (payouts are deferred) — deleting the order would cascade it away' },
  { table: 'agent_payout_items', column: 'order_id', fk: 'NO ACTION', action: 'block', snapshot: 'rows', order: 'x.id', keySql: 'x.id::text',
    why: 'an agent payout line (payouts are deferred) — the FK refuses the delete anyway' },
  { table: 'altercpa_leads', column: 'order_id', fk: 'SET NULL', action: 'unlink', snapshot: 'link', key: 'id', order: 'x.id',
    extra: ['altercpa_id', 'phase', 'skip_reason', 'created_remote'], restore: 'relink (only while still unlinked)' },
  { table: 'mex_parcels', column: 'order_id', fk: 'SET NULL', action: 'unlink', snapshot: 'link', key: 'tracking_id', order: 'x.tracking_id',
    extra: ['link_method', 'linked_at', 'account', 'series', 'status_id', 'cod_mkd'], alsoClear: ['link_method', 'linked_at'],
    restore: 'relink with its link_method / linked_at (only while still unlinked)' },
  { table: 'orders', column: 'duplicated_from', fk: 'SET NULL', action: 'unlink', snapshot: 'link', key: 'id', order: 'x.id',
    extra: ['display_id'], restore: 'relink (only while still NULL)' },
  { table: 'prediction_segment_members', column: 'trigger_order_id', fk: 'SET NULL', action: 'engine', snapshot: 'rows', order: 'x.list_id', keySql: "x.list_id::text || ' ' || x.customer_phone",
    restore: 'the insert trigger recomputes the phone; trigger_order_id relinked on rows that survived' },
  { table: 'order_locks', column: 'order_id', fk: null, action: 'delete', snapshot: 'rows', order: 'x.id', keySql: 'x.id::text', restore: 'not restored (a stale edit lock)' },
  { table: 'missed_calls', column: 'linked_order_id', fk: null, action: 'unlink', snapshot: 'link', key: 'id', order: 'x.id', restore: 'relink (only while still NULL)' },
  { table: 'call_logs', column: 'context_id', fk: null, where: "x.context_type = 'order'", action: 'keep', snapshot: 'ids', key: 'id', order: 'x.id',
    why: 'agent call activity — kept; its context_id then names a deleted order' },
  { table: 'affiliate_postbacks', column: 'order_id', fk: null, action: 'keep', snapshot: 'ids', key: 'id', order: 'x.id', why: 'what was sent to a partner — kept' },
  { table: 'no_parcel_rule_items', column: 'other_order_id', fk: null, action: 'keep', snapshot: 'ids', key: 'run_id', order: 'x.run_id', why: 'the 7-day rule ledger — kept' },
  { table: 'data_repair_rows', column: 'order_id', fk: null, action: 'keep', snapshot: 'ids', key: 'id', order: 'x.id', why: 'the repair ledger outlives orders by design — kept' },
]);

/** The SQL that names one dependent row (alias x) — its key for the listing. */
export const depKeySql = (d) => d.keySql || `x.${d.key}::text`;

/** confdeltype → words (pg_constraint). */
export const FK_RULE = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };

/**
 * Compare the live foreign keys onto orders(id) with DEPENDENTS. Anything unknown, or a rule
 * that differs from what this script was written against, blocks an apply.
 * live: [{ tbl: 'public.order_items' | 'order_items', col, rule: 'c'|'n'|… }]
 */
export function verifyForeignKeys(live, deps = DEPENDENTS) {
  const known = new Map(deps.filter((d) => d.fk).map((d) => [`${d.table}.${d.column}`, d.fk]));
  const problems = [];
  const seen = new Set();
  for (const r of live) {
    const k = `${String(r.tbl).replace(/^public\./, '')}.${r.col}`;
    seen.add(k);
    const rule = FK_RULE[r.rule] || r.rule;
    if (!known.has(k)) problems.push(`unknown foreign key ${k} → orders(id) ON DELETE ${rule}: this script does not know what to do with it`);
    else if (known.get(k) !== rule && !(known.get(k) === 'NO ACTION' && rule === 'RESTRICT')) problems.push(`${k} is ON DELETE ${rule} live, the script expects ${known.get(k)}`);
  }
  for (const k of known.keys()) if (!seen.has(k)) problems.push(`expected foreign key ${k} → orders(id) is not in the database (dropped?)`);
  return problems;
}

// ─── classification (pure) ─────────────────────────────────────────────────
const OPEN_AT_ALTERCPA = new Set([1, 2]);
/** How far back the AlterCPA sweeps re-read leads (weekly = 90 d), with a margin. */
export const RECREATE_WINDOW_DAYS = 100;

/**
 * @param orders    every order whose last 8 digits are a test number
 * @param blocks    Map order_id → [table, …] of 'block' dependents present
 * @param cpaLeads  Map order_id → [{ altercpa_id, phase, skip_reason, created_remote }]
 * @returns {{ rows, lines, counts }}  rows carry rule/why; lines are the hash lines of the
 *          orders to delete (planLine(order_id, 'delete', status, phone8)).
 *
 * Rules, first match wins:
 *   held                    --hold
 *   other_prefix            only the last 8 digits agree (a different number) — listed
 *   open_in_agent_hands     status 'take' — an agent has it open right now
 *   in_payout / affiliate_lead   a 'block' dependent (payouts are deferred) — listed
 *   altercpa_would_recreate the AlterCPA lead is still open there (phase 1/2) and recent:
 *                           the next sync sweep would insert the order again
 *                           (altercpa-sync upsertLead → upsertOrder). Deleted only with
 *                           --include-pending-altercpa.
 *   delete                  everything else
 */
export function classifyTestPhoneOrders({ orders, blocks = new Map(), cpaLeads = new Map(), hold = new Set(),
  includePendingAltercpa = false, nowMs = Date.now(), phones = TEST_PHONE8S }) {
  const rows = [], lines = [];
  const counts = { total: 0 };
  const sorted = [...orders].sort((a, b) => String(a.display_id).localeCompare(String(b.display_id)));
  for (const o of sorted) {
    const form = testNumberForm(o.customer_phone, phones);
    if (!form) continue;
    counts.total++;
    const b = blocks.get(o.id) || [];
    const leads = cpaLeads.get(o.id) || [];
    const openLead = leads.find((l) => OPEN_AT_ALTERCPA.has(Number(l.phase))
      && (toMs(l.created_remote) === null || nowMs - toMs(l.created_remote) < RECREATE_WINDOW_DAYS * DAY_MS));
    let rule = 'delete', why = '';
    if (hold.has(o.display_id)) { rule = 'held'; why = 'held back with --hold'; }
    else if (form === 'other_prefix') { rule = 'other_prefix'; why = `only the last 8 digits match a test number — ${o.customer_phone} is a different number`; }
    else if (o.status === 'take') { rule = 'open_in_agent_hands'; why = 'status take: an agent has it open right now'; }
    else if (b.includes('agent_payout_items')) { rule = 'in_payout'; why = 'in agent_payout_items (payouts are deferred) — not deleted'; }
    else if (b.includes('affiliate_leads')) { rule = 'affiliate_lead'; why = 'has an affiliate_leads row (partner payout snapshot) — not deleted'; }
    else if (openLead && !includePendingAltercpa) {
      rule = 'altercpa_would_recreate';
      why = `AlterCPA lead #${openLead.altercpa_id} is still open there (phase ${openLead.phase}) — the next sync sweep would insert this order again; ` +
        'close it in AlterCPA first, or pass --include-pending-altercpa';
    }
    counts[rule] = (counts[rule] || 0) + 1;
    const p8 = last8(o.customer_phone);
    rows.push({ ...o, rule, why, phone8: p8, form, blocks: b, altercpa: leads });
    if (rule === 'delete') lines.push(planLine(o.id, 'delete', o.status, p8));
  }
  return { rows, lines, counts };
}

// ─── SQL (strings only; run by the CLI through the kit's sql()) ─────────────
const tableSql = (t) => `public.${t}`;
const where = (d, o) => `x.${d.column} = ${o}.id${d.where ? ` and ${d.where}` : ''}`;

/** jsonb array of one dependent's rows for the order aliased `o` (the snapshot shape). */
export function depSnapshotSql(d, o) {
  let el;
  if (d.snapshot === 'rows') el = 'to_jsonb(x)';
  else if (d.snapshot === 'link') {
    const cols = [d.key, d.column, ...(d.extra || [])];
    el = `jsonb_build_object(${[...new Set(cols)].map((c) => `'${c}', x.${c}`).join(', ')})`;
  } else el = `to_jsonb(x.${d.key})`;
  return `coalesce((select jsonb_agg(${el} order by ${d.order}) from ${tableSql(d.table)} x where ${where(d, o)}${d.table === 'orders' ? ` and x.id <> ${o}.id` : ''}), '[]'::jsonb)`;
}

/** The full before-image of one order + every dependent (data_repair_rows.before). */
export function orderSnapshotSql(o, deps = DEPENDENTS) {
  const parts = deps.map((d) => `'${d.table}.${d.column}', ${depSnapshotSql(d, o)}`);
  return `jsonb_build_object('kind', 'deleted_order', 'order', to_jsonb(${o}), 'deps', jsonb_build_object(${parts.join(', ')}))`;
}

/**
 * ONE transaction per chunk (no explicit BEGIN/COMMIT — see the kit's buildChunkSql):
 * lock → keep only orders still as planned and still deletable → snapshot every row into
 * data_repair_rows.before → unlink the ledger rows → delete → verify → after.
 * rows: [{ order_id, expect_status, expect_phone, expect_tracking, rule, evidence }]
 */
export function buildDeleteChunkSql({ runId, rows, deps = DEPENDENTS, phones = TEST_PHONE8S }) {
  if (!rows.length) throw new Error('empty chunk');
  if (rows.length > MAX_CHUNK) throw new Error(`chunk of ${rows.length} > ${MAX_CHUNK}`);
  const actor = `System (repair:${KEY})`;
  const values = rows.map((r) => `(${[qUuid(r.order_id), q(r.expect_status), q(r.expect_phone), q(r.expect_tracking ?? null), q(r.rule || 'delete'), qJson(r.evidence || {})].join(', ')})`);
  const blocking = deps.filter((d) => d.action === 'block');
  const unlinks = deps.filter((d) => d.action === 'unlink');
  const explicitDeletes = deps.filter((d) => d.action === 'delete' && !d.fk);
  const cascades = deps.filter((d) => d.action === 'delete' && d.fk === 'CASCADE');
  const unlinkSql = unlinks.map((d) => {
    const clear = [d.column, ...(d.alsoClear || [])].map((c) => `${c} = null`).join(', ');
    const notSelf = d.table === 'orders' ? ' and x.id not in (select order_id from _ok)' : '';
    return `update ${tableSql(d.table)} x set ${clear} from _ok k where x.${d.column} = k.order_id${notSelf};`;
  }).join('\n');
  const deleteSql = explicitDeletes.map((d) => `delete from ${tableSql(d.table)} x using _ok k where x.${d.column} = k.order_id;`).join('\n');
  const leftoverChecks = [...unlinks, ...explicitDeletes, ...cascades].map((d) =>
    `  select count(*) into n from ${tableSql(d.table)} x join _ok k on x.${d.column} = k.order_id;
  if n > 0 then raise exception 'repair: % ${d.table}.${d.column} row(s) still point at a deleted order', n; end if;`).join('\n');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _plan (
  order_id uuid primary key, expect_status text not null, expect_phone text not null, expect_tracking text,
  rule text not null, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

select count(*) from (select 1 from public.orders where id in (select order_id from _plan) order by id for update) l;

-- still as planned, still a test number, still free of every blocking row
create temp table _ok on commit drop as
select p.* from _plan p join public.orders o on o.id = p.order_id
 where o.status::text = p.expect_status
   and o.customer_phone = p.expect_phone
   and o.mex_tracking_id is not distinct from p.expect_tracking
   and right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = any(${qTextArray([...phones])})
${blocking.map((d) => `   and not exists (select 1 from ${tableSql(d.table)} x where x.${d.column} = o.id)`).join('\n')};

-- the before-image of every order and every row that points at it
insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, o.id, k.rule, ${orderSnapshotSql('o', deps)}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;

-- never delete a ledger row: unlink it (the snapshot above is how --restore relinks it)
${unlinkSql}
${deleteSql}

-- the delete: order_items, order_history, order_notes, order_unpaid_alerts and
-- no_parcel_rule_items go by FK CASCADE; prediction_segment_members.trigger_order_id is
-- SET NULL by its FK and the AFTER DELETE trigger recomputes the phone's lists
delete from public.orders o using _ok k where o.id = k.order_id;

do $chk$
declare n int;
begin
  select count(*) into n from public.orders o join _ok k on k.order_id = o.id;
  if n > 0 then raise exception 'repair: % order(s) were not deleted', n; end if;
${leftoverChecks}
end $chk$;

update public.data_repair_rows r
   set after = jsonb_build_object('kind', 'deleted_order', 'deleted', true, 'deleted_at', now(), 'by', ${q(actor)})
  from _ok k
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

/**
 * The per-phone record (one data_repair_rows row with order_id NULL, rule 'phone'): what the
 * engine and the shop keep for the test numbers — segment memberships (the AFTER DELETE
 * recompute drops the non-static ones), the customer profile, web orders and MEX parcels on
 * the phone. Informational: --restore does not replay it (the engine recomputes).
 */
export function phoneSnapshotSql({ runId, phones = TEST_PHONE8S }) {
  const arr = qTextArray([...phones]);
  return `insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, null, 'phone', jsonb_build_object(
  'kind', 'test_phones',
  'phone8', ${arr},
  'segment_members', coalesce((select jsonb_agg(to_jsonb(x) order by x.customer_phone, x.list_id) from public.prediction_segment_members x
                               where right(regexp_replace(x.customer_phone, '[^0-9]', '', 'g'), 8) = any(${arr})), '[]'::jsonb),
  'customer_profiles', coalesce((select jsonb_agg(to_jsonb(x) order by x.phone) from public.customer_profiles x
                                 where right(regexp_replace(x.phone, '[^0-9]', '', 'g'), 8) = any(${arr})), '[]'::jsonb),
  'web_orders', coalesce((select jsonb_agg(x.shop_order_id order by x.shop_order_id) from public.web_orders x where x.phone8 = any(${arr})), '[]'::jsonb),
  'mex_parcels', coalesce((select jsonb_agg(x.tracking_id order by x.tracking_id) from public.mex_parcels x where x.phone8 = any(${arr})), '[]'::jsonb)
), jsonb_build_object('key', ${q(KEY)}, 'note', 'kept: web orders + MEX parcels (excluded from reports by is_report_excluded_phone), customer profiles; segment members are the engine''s')
where not exists (select 1 from public.data_repair_rows r where r.run_id = ${qUuid(runId)} and r.rule = 'phone');`;
}

/**
 * Re-insert deleted orders from the ledger snapshot. ONE transaction (≤ 200 orders):
 *   orders       inserted with every snapshot value; an AlterCPA order whose status is
 *                paid/returned/shipped/delivered goes in as confirmed first (the BEFORE INSERT
 *                money guard allows nothing else) and is moved to its status right after;
 *                then every column is written back exactly (updated_at kept via
 *                elyon.keep_updated_at, sold_* via elyon.allow_sold_change, sale_source via
 *                elyon.allow_source_change; notifications silenced by elyon.bulk_repair)
 *   cascaded     order_items, order_history, order_notes, order_unpaid_alerts,
 *                no_parcel_rule_items (when its run still exists) re-inserted verbatim
 *   unlinked     altercpa_leads / mex_parcels / missed_calls / orders.duplicated_from /
 *                prediction_segment_members.trigger_order_id relinked ONLY where still
 *                unlinked; a parcel another order took since raises (nothing restored)
 * cols: { orders: [...], order_items: [...], … } insertable column names per table.
 * identity: Set of tables with a GENERATED ALWAYS identity column (OVERRIDING SYSTEM VALUE).
 */
export function buildRestoreSql({ runId, restoreRunId, orderIds, cols, identity = new Set(), deps = DEPENDENTS }) {
  if (!orderIds.length) throw new Error('nothing to restore');
  if (orderIds.length > MAX_CHUNK) throw new Error(`chunk of ${orderIds.length} > ${MAX_CHUNK}`);
  const actor = `System (${RESTORE_KEY})`;
  const oc = cols.orders;
  if (!oc?.includes('id') || !oc.includes('status')) throw new Error('orders column list is incomplete');
  const colList = (c) => c.map((x) => `"${x}"`).join(', ');
  const sel = (c, alias) => c.map((x) => `${alias}."${x}"`).join(', ');
  const ov = (t) => (identity.has(t) ? ' overriding system value' : '');
  const MONEY = `('paid', 'returned', 'shipped', 'delivered')`;
  const insertOrders = `insert into public.orders (${colList(oc)})${ov('orders')}
select ${oc.map((c) => (c === 'status'
    ? `case when r.source_type = 'altercpa' and r.status::text in ${MONEY} then 'confirmed'::public.order_status else r.status end`
    : `r."${c}"`)).join(', ')}
  from _ro r;`;
  const exact = oc.filter((c) => c !== 'id' && c !== 'status');
  const reinserts = deps.filter((d) => d.snapshot === 'rows' && d.restore && d.restore.startsWith('reinsert')).map((d) => {
    const c = cols[d.table];
    if (!c?.length) throw new Error(`no column list for ${d.table}`);
    const guard = d.table === 'no_parcel_rule_items' ? ' where exists (select 1 from public.no_parcel_rule_runs rr where rr.id = x.run_id)' : '';
    return `insert into public.${d.table} (${colList(c)})${ov(d.table)}
select ${sel(c, 'x')} from _rs cross join lateral jsonb_populate_recordset(null::public.${d.table}, _rs.before->'deps'->'${d.table}.${d.column}') x${guard};`;
  }).join('\n');
  const link = (d) => `_rs.before->'deps'->'${d.table}.${d.column}'`;
  const relinks = [];
  for (const d of deps.filter((x) => x.action === 'unlink')) {
    if (d.table === 'mex_parcels') {
      relinks.push(`update public.mex_parcels mp
   set order_id = _rs.order_id, link_method = y->>'link_method', linked_at = (y->>'linked_at')::timestamptz
  from _rs cross join lateral jsonb_array_elements(${link(d)}) y
 where mp.tracking_id = y->>'tracking_id' and (mp.order_id is null or mp.order_id = _rs.order_id);`);
    } else {
      relinks.push(`update public.${d.table} t set ${d.column} = _rs.order_id
  from _rs cross join lateral jsonb_array_elements(${link(d)}) y
 where t.${d.key} = (y->>'${d.key}')::${d.key === 'id' ? 'uuid' : 'text'} and t.${d.column} is null;`);
    }
  }
  const members = deps.find((d) => d.table === 'prediction_segment_members');
  if (members) {
    relinks.push(`update public.prediction_segment_members m set trigger_order_id = _rs.order_id
  from _rs cross join lateral jsonb_array_elements(${link(members)}) y
 where m.list_id = (y->>'list_id')::uuid and m.customer_phone = y->>'customer_phone' and m.trigger_order_id is null;`);
  }
  const parcels = deps.find((d) => d.table === 'mex_parcels');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.allow_sold_change = 'on';
set local elyon.allow_source_change = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _rs on commit drop as
select r.order_id, r.before from public.data_repair_rows r
 where r.run_id = ${qUuid(runId)} and r.rule = 'delete' and r.after is not null
   and r.before->>'kind' = 'deleted_order' and r.order_id = any(${qUuidArray(orderIds)});

create temp table _ro on commit drop as
select o.* from _rs cross join lateral jsonb_populate_record(null::public.orders, _rs.before->'order') o;

do $chk$
declare n int;
begin
  select count(*) into n from _rs;
  if n <> ${orderIds.length} then raise exception 'restore: % of ${orderIds.length} snapshot row(s) found in run ${runId}', n; end if;
  select count(*) into n from public.orders o join _ro r on o.id = r.id or o.display_id = r.display_id;
  if n > 0 then raise exception 'restore: % order(s) of this run exist again (restored already?)', n; end if;
  select count(*) into n from _ro r where r.source_type = 'affiliate';
  if n > 0 then raise exception 'restore: % affiliate order(s) — never deleted by this repair, not restorable here', n; end if;
end $chk$;
${parcels ? `
-- a parcel the order held must still be free (or already its own) — else nothing is restored
do $chk$
declare bad text;
begin
  select string_agg((y->>'tracking_id') || ' now on ' || coalesce(o.display_id, mp.order_id::text), ', ') into bad
    from _rs cross join lateral jsonb_array_elements(${link(parcels)}) y
    join public.mex_parcels mp on mp.tracking_id = y->>'tracking_id'
    left join public.orders o on o.id = mp.order_id
   where mp.order_id is not null and mp.order_id <> _rs.order_id;
  if bad is not null then raise exception 'restore: parcel(s) taken by another order since the delete: %', bad; end if;
end $chk$;
` : ''}
${insertOrders}

-- AlterCPA money statuses: inserted as confirmed (the BEFORE INSERT guard), moved now
update public.orders o set status = r.status from _ro r where o.id = r.id and o.status is distinct from r.status;

-- every other column back to its snapshot value, exactly
update public.orders o set ${exact.map((c) => `"${c}" = r."${c}"`).join(', ')}
  from _ro r where o.id = r.id;

${reinserts}

${relinks.join('\n')}

do $chk$
declare n int;
begin
  select count(*) into n from _ro r join public.orders o on o.id = r.id
   where o.status is distinct from r.status or o.price is distinct from r.price
      or o.customer_phone is distinct from r.customer_phone or o.updated_at is distinct from r.updated_at;
  if n > 0 then raise exception 'restore: % order(s) did not come back exactly', n; end if;
end $chk$;

insert into public.order_notes (order_id, text, author_id, author_name)
select r.id, ${q(`Restored by scripts/repair-test-phones.mjs --restore from the snapshot of run ${String(runId)} (it had been deleted as a test-phone order).`)}, null, ${q(actor)}
  from _ro r;

insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(restoreRunId)}, r.id, 'restore', jsonb_build_object('kind', 'deleted_order', 'exists', false),
       jsonb_build_object('kind', 'restored_order', 'exists', true, 'status', o.status::text, 'display_id', o.display_id),
       jsonb_build_object('restored_from_run', ${q(runId)}, 'line', r.id::text || ':restore:' || r.status::text || ':')
  from _ro r join public.orders o on o.id = r.id;

select (select count(*) from _rs)::int as planned, (select count(*) from _ro r join public.orders o on o.id = r.id)::int as restored;`;
}
