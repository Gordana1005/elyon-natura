/**
 * "Legacy – no seller" — the real sales no evidence can credit, accepted with NO seller (owner, Mile,
 * 02.10.2026 ~00:30: "mark them legacy – no seller; they must stop showing as an error and nobody gets
 * credit"). No shebang (repair-kit convention). Run with `node`.
 *
 *   node scripts/repair-legacy-no-seller.mjs                          # DRY RUN → CSV → data_repair_runs row → run id
 *   node scripts/repair-legacy-no-seller.mjs --apply --run <id>       # mark (quiet window; needs migration 20260944001300)
 *        [--actor mile@elyon.com] [--chunk 200] [--outside-quiet-window]
 *   node scripts/repair-legacy-no-seller.mjs --rollback --run <id> [--apply]   # undo one applied run
 *   options (recorded; the apply must repeat them):
 *     --approved-sources <csv>   the seller sources the owner approved (default login-names,canceller)
 *     --collab-dir / --data-dir  as scripts/repair-seller-matching.mjs (the same evidence files)
 *     --preview                  a dry run that records nothing
 *
 * ── WHICH ORDERS (computed LIVE, the same evidence load as repair-seller-matching.mjs) ───────────────
 * The stamping cron's `unresolved` list (order_decider_plan, 10 years — with 20260944001200 applied the
 * undone MEX flips are no longer in it), each order classified TWICE by repair-seller-matching's
 * classify():
 *   A  with the APPROVED sources only — a stamp here belongs to the seller-matching run (the 271):
 *      never marked, whether that run is applied before or after this one;
 *   B  with EVERY source — a stamp here that A does not make is a sale only an UNAPPROVED source could
 *      credit (export-phone, corrections, mex/db-phone, own-doc, canceller-trashed — the ~143): left
 *      plain unresolved, apart, for the owner;
 *   not a cohort sale now (a replacement parcel, COD 0) or a test phone: left alone;
 *   everything else — B holds it or knows nobody — is MARKED: "legacy – no seller".
 *
 * ── THE MARKER (migration 20260944001300) ───────────────────────────────────────────────────────────
 * sold_via = 'legacy_no_seller', sold_at = the sale's cohort moment today (coalesce(AlterCPA approval,
 * confirmed_at, created_at) — no sale moves a day or a month), sold_by_person_id NULL, sold_by_ext NULL
 * (orders_sold_via_check refuses a person or a handle on it). The cron takes only sold_at IS NULL, so it
 * never lists or re-stamps a marked sale; insights / the TV board keep it under "no seller" (reason
 * 'legacy_no_seller'), and the data-quality "no seller" warning no longer counts it.
 *
 * ── APPLY / ROLLBACK (repair-kit protocol) ──────────────────────────────────────────────────────────
 * Re-classify, refuse unless the hash equals the dry run's; ≤ 200-order transactions with
 * elyon.bulk_repair + elyon.keep_updated_at (updated_at is Call Again's last_call_at), FOR NO KEY
 * UPDATE, only orders still unstamped with the planned status + tracking id; data_repair_rows before →
 * UPDATE sold_at / sold_via (NULL → value; the write-once trigger stays on) → verify → after. No
 * order_history / order_notes row: a bookkeeping stamp, like the stamping cron. --rollback clears the
 * marks of one run where they still equal the after-image (elyon.allow_sold_change,
 * backfill-sellers-collabbox.mjs's rollback SQL).
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards).
 */
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  MAX_CHUNK, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qJson, parseArgs, fmtSkopje, fmtMkd, fileStamp, writeCsv, printTable,
  planLine, candidateHash, recordDryRun, verifyRunForApply, applyChunked, finalizeRun, auditPartial, resolveActor, isUuid,
} from './lib/repair-kit.mjs';
import { loadEvidence, classify, SOURCES } from './repair-seller-matching.mjs';
import { buildRollbackChunkSql } from './backfill-sellers-collabbox.mjs';

export const KEY = 'legacy-no-seller';
export const VIA = 'legacy_no_seller';
export const APPROVED_DEFAULT = Object.freeze(['login-names', 'canceller']);
const PERIODS = ['before_march', 'march', 'from_april'];

/** The group a marked sale is reported under (from the every-source verdict B). */
export function legacyGroup(b) {
  const reason = String(b.reason ?? '');
  if (b.outcome === 'hold') {
    if (!reason.includes(':')) return reason;                       // doc_predates_order, non_collabbox_parcel, …
    const src = reason.split(':')[0];                               // 'export-phone:doc_fits_another_sale' …
    return /-phone$/.test(src) ? 'phone_ambiguous' : `${src}_ambiguous`;
  }
  const m = reason.match(/login_(\d+)(?:@\d{4}-\d{2})?_(not_one_person|no_documents)/);
  if (m) return `login_${m[1]}_${m[2]}`;
  return reason.split(' · ')[0] || 'unknown';
}

/**
 * One order: A = classify with the approved sources, B = with every source.
 * → { verdict: 'legacy' | 'approved_sources' | 'other_sources_only' | 'skip', group?, source?, reason? }
 */
export function legacyVerdict(a, b) {
  if (a.outcome === 'skip') return { verdict: 'skip', reason: a.reason };
  if (a.outcome === 'stamp') return { verdict: 'approved_sources', source: a.source };
  if (b.outcome === 'stamp') return { verdict: 'other_sources_only', source: b.source };
  return { verdict: 'legacy', group: legacyGroup(b) };
}

export const legacyLine = (orderId, saleAt, group) => planLine(orderId, 'legacy', `${VIA}|${saleAt}`, group);

// ─── apply SQL ──────────────────────────────────────────────────────────────
/** The same snapshot shape as backfill-sellers-collabbox.mjs (kind 'sold') — its rollback SQL reads it. */
const soldSnapshotSql = (o) => `jsonb_build_object('kind', 'sold', 'sold_at', ${o}.sold_at, 'sold_by_person_id', ${o}.sold_by_person_id,
    'sold_via', ${o}.sold_via, 'sold_by_ext', ${o}.sold_by_ext, 'status', ${o}.status::text,
    'mex_tracking_id', ${o}.mex_tracking_id, 'updated_at', ${o}.updated_at)`;

/** One ≤ 200-order chunk = ONE implicit transaction (repair-kit buildChunkSql's reasoning). */
export function buildLegacyChunkSql({ runId, rows }) {
  if (!rows.length) throw new Error('empty chunk');
  if (rows.length > MAX_CHUNK) throw new Error(`chunk of ${rows.length} > ${MAX_CHUNK}`);
  const values = rows.map((r) => `(${[
    qUuid(r.order_id), q(r.group), `${q(r.sold_at)}::timestamptz`, q(r.status), q(r.expect_tracking ?? null),
    qJson({ ...r.evidence, line: r.line }),
  ].join(', ')})`);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _plan (
  order_id uuid primary key, group_key text not null, sold_at timestamptz not null,
  expect_status text not null, expect_tracking text, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

select count(*) from (select 1 from public.orders where id in (select order_id from _plan) order by id for no key update) l;

-- only orders still entirely unstamped, in the status and on the parcel the plan saw
create temp table _ok on commit drop as
select p.* from _plan p join public.orders o on o.id = p.order_id
 where o.sold_at is null and o.sold_by_person_id is null and o.sold_via is null and o.sold_by_ext is null
   and o.status::text = p.expect_status
   and o.mex_tracking_id is not distinct from p.expect_tracking;

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, k.order_id, 'legacy:' || k.group_key, ${soldSnapshotSql('o')}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;

update public.orders o
   set sold_at = k.sold_at, sold_via = '${VIA}'
  from _ok k
 where o.id = k.order_id and o.sold_at is null;

do $chk$
declare n int;
begin
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id
   where o.sold_at is distinct from k.sold_at or o.sold_via is distinct from '${VIA}'
      or o.sold_by_person_id is not null or o.sold_by_ext is not null;
  if n > 0 then raise exception 'legacy-no-seller: % order(s) did not take the mark', n; end if;
end $chk$;

update public.data_repair_rows r set after = ${soldSnapshotSql('o')}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

// ─── the plan ───────────────────────────────────────────────────────────────
export async function buildLegacyPlan({ collabDir, dataDir, approved }) {
  const ev = await loadEvidence({ collabDir, dataDir });
  const all = new Set(SOURCES);
  const rows = ev.orders.map((o) => {
    const a = classify(o, { ...ev.ctx, opts: { sources: approved } });
    const b = classify(o, { ...ev.ctx, opts: { sources: all } });
    const v = legacyVerdict(a, b);
    return { o, a, b, ...v, period: b.period, value_mkd: b.value_mkd, sale_at: o.sale_at };
  });
  const marks = rows.filter((r) => r.verdict === 'legacy');
  const lineOf = new Map(marks.map((r) => [r.o.id, legacyLine(r.o.id, r.sale_at, r.group)]));
  return { ...ev, rows, marks, lines: [...lineOf.values()], lineOf };
}

function report(rows) {
  const by = (f) => {
    const t = {};
    for (const r of rows) {
      const k = f(r);
      if (!k) continue;
      t[k] ??= { what: k, orders: 0, ден: 0, ...Object.fromEntries(PERIODS.map((p) => [p, 0])) };
      t[k].orders++; t[k].ден += r.value_mkd; t[k][r.period]++;
    }
    return Object.values(t).sort((x, y) => y.orders - x.orders).map((x) => ({ ...x, ден: fmtMkd(x.ден) }));
  };
  console.log(bold(`\n── The cron's unresolved list, live: ${rows.length} sales ──`));
  printTable(by((r) => (r.verdict === 'legacy' ? 'MARK: legacy – no seller' : r.verdict === 'approved_sources' ? 'seller-matching run (approved sources)'
    : r.verdict === 'other_sources_only' ? 'stays unresolved: only an unapproved source names someone' : `left alone: ${r.reason}`)));
  console.log(bold('\n── Marked "legacy – no seller", by group ──'));
  printTable(by((r) => (r.verdict === 'legacy' ? r.group : null)));
  console.log(bold('\n── Stays plain unresolved (only an unapproved source would credit them), by that source ──'));
  printTable(by((r) => (r.verdict === 'other_sources_only' ? r.source : null)));
}

// ─── main ───────────────────────────────────────────────────────────────────
function parseApproved(s) {
  const list = s ? String(s).split(',').map((x) => x.trim()).filter(Boolean) : [...APPROVED_DEFAULT];
  for (const x of list) if (!SOURCES.includes(x)) die(`--approved-sources: unknown source "${x}" (known: ${SOURCES.join(', ')})`);
  return new Set(list);
}

async function requireMarkerSchema({ forApply }) {
  const [c] = await sqlRead(`select coalesce((select pg_get_constraintdef(c.oid) from pg_constraint c
      where c.conrelid = 'public.orders'::regclass and c.conname = 'orders_sold_via_check'), '') as def`);
  if (String(c.def).includes(VIA)) { ok('orders_sold_via_check accepts legacy_no_seller (20260944001300)'); return true; }
  const msg = 'orders_sold_via_check does not accept legacy_no_seller yet — apply migration 20260944001300 first';
  if (forApply) die(msg);
  warn(`${msg} (fine for a dry run, BLOCKS --apply).`);
  return false;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'rollback', 'outside-quiet-window', 'preview'],
    values: ['run', 'actor', 'chunk', 'collab-dir', 'data-dir', 'approved-sources'],
  });
  const APPLY = !!args.apply;
  mkGuard();
  console.log(bold(`\nLegacy – no seller — ${KEY}`) + (APPLY ? yellow(' — APPLY') : ' — dry run'));
  await assertRemoteIsMk();
  await requireKeepUpdatedAt({ forApply: APPLY && !args.rollback });
  if (args.rollback) return rollback(args);
  await requireMarkerSchema({ forApply: APPLY });

  const approved = parseApproved(args['approved-sources']);
  const options = { approved_sources: SOURCES.filter((s) => approved.has(s)) };
  const plan = await buildLegacyPlan({ collabDir: args['collab-dir'] || undefined, dataDir: args['data-dir'] || null, approved });
  const { rows, marks, lines, lineOf } = plan;
  report(rows);
  const csv = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, rows.map((r) => ({
    order: r.o.display_id, verdict: r.verdict, group: r.group || '', source: r.source || '', reason: r.reason || r.b.reason || '',
    period: r.period, sale_at: fmtSkopje(r.sale_at), status: r.o.status, value_mkd: r.value_mkd, tracking: r.b.tracking,
    altercpa: r.b.altercpa, operator_login: r.b.ev.operator?.login || '', operator_month: r.b.ev.operator?.month || '',
  })));
  ok(`CSV (stays in exports/): ${csv}`);
  const count = (v) => rows.filter((r) => r.verdict === v).length;
  const groups = {};
  for (const r of marks) {
    groups[r.group] ??= { orders: 0, value_mkd: 0, ...Object.fromEntries(PERIODS.map((p) => [p, 0])) };
    groups[r.group].orders++; groups[r.group].value_mkd += r.value_mkd; groups[r.group][r.period]++;
  }
  const summary = {
    script: 'repair-legacy-no-seller.mjs', options, evidence: plan.evidence,
    counts: { unresolved: rows.length, legacy: marks.length, approved_sources: count('approved_sources'),
      other_sources_only: count('other_sources_only'), skip: count('skip') },
    groups, csv: csv.split(/[\\/]/).pop(),
  };

  if (!APPLY) {
    if (!lines.length) { console.log(bold('\nNothing to mark — no run recorded.\n')); return; }
    if (args.preview) { console.log(bold(`\nPreview only (--preview): ${lines.length} orders would be marked; no run recorded.\n`)); return; }
    const { id, hash } = await recordDryRun({ key: KEY, lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…, ${lines.length} orders)`);
    console.log('Nothing was written to orders. After migration 20260944001300, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-legacy-no-seller.mjs --apply --run ${id}${args['approved-sources'] ? ` --approved-sources ${options.approved_sources.join(',')}` : ''}\n`);
    return;
  }

  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines, options });
  const items = marks.filter((r) => !done.has(r.o.id)).map((r) => ({
    order_id: r.o.id, group: r.group, sold_at: r.sale_at, status: r.o.status, expect_tracking: r.o.tr,
    line: lineOf.get(r.o.id), evidence: { group: r.group, period: r.period, reason: r.b.reason, operator_login: r.b.ev.operator?.login ?? null },
  }));
  console.log(bold(`\nMarking ${items.length} orders "legacy – no seller"`));
  const stats = await applyChunked({ items, build: (chunk) => buildLegacyChunkSql({ runId: args.run, rows: chunk }), chunkSize: Number(args.chunk) || MAX_CHUNK });
  const payload = { script: 'repair-legacy-no-seller.mjs', options, counts: summary.counts, applied_orders: stats.applied,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger. Re-run the same --apply to resume.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders marked${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);
  const [v] = await sqlRead(`select count(*)::int as ledger_rows,
      count(*) filter (where (r.after->>'updated_at')::timestamptz is distinct from (r.before->>'updated_at')::timestamptz)::int as updated_at_moved
    from public.data_repair_rows r where r.run_id = ${qUuid(args.run)} and r.after is not null`);
  printTable([v]);
  if (v.updated_at_moved) warn(`${v.updated_at_moved} order(s) had updated_at moved — the keep_updated_at guard did not hold.`);
  console.log(yellow('  Next: node scripts/verify-stamp-parity.mjs (check 3 counts them as accepted: no seller) and the Agents tab.\n'));
}

async function rollback(args) {
  if (!isUuid(args.run)) die('--rollback needs --run <the applied run id>');
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
  if (!run || run.key !== KEY) die(`run ${args.run} is not a ${KEY} run.`);
  if (!run.applied_at) die(`run ${args.run} was never applied — nothing to roll back.`);
  const rows = await sqlRead(`select order_id from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null`);
  const ids = rows.map((r) => r.order_id);
  console.log(bold(`\nRollback of ${args.run}: ${ids.length} marked orders`) + (args.apply ? yellow(' — APPLY') : ' — preview (pass --apply)'));
  if (!args.apply || !ids.length) return;
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rbKey = `rollback-${KEY}`;
  const rbRunId = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rbRunId)}, ${q(rbKey)}, false, ${q(candidateHash(ids))}, ${qJson({ rolled_back_run: args.run, orders: ids.length })})`);
  const stats = await applyChunked({ items: ids, build: (chunk) => buildRollbackChunkSql({ runId: args.run, rbRunId, orderIds: chunk }), label: 'orders' });
  const payload = { rolled_back_run: args.run, restored: stats.applied, skipped_changed: stats.skipped, chunks: `${stats.committed}/${stats.chunks}` };
  if (stats.failed) {
    await auditPartial({ key: rbKey, runId: rbRunId, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; re-run to continue (restored rows are no longer equal to after and are skipped).`);
  }
  await finalizeRun({ key: rbKey, runId: rbRunId, actor, payload });
  ok(`rolled back ${stats.applied} marks (${stats.skipped.length} changed since and left alone) — run ${rbRunId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
