/**
 * Backfill — collabbox_documents.booked_at for the documents the ledger held before migration
 * 20260944000500 (owner 01.10.2026: a collabBox sale counts on the day the operator BOOKED it; the
 * document date is the dispatch day). No shebang (repair-kit convention).
 *
 *   node scripts/backfill-collabbox-booked-at.mjs                    # DRY RUN (default) — READ-ONLY:
 *        [--since YYYY-MM-DD]   the cutoff to simulate (default: the live collabbox_booking_day_since(),
 *                               2026-10-01 before the migration)
 *        [--redecide]           also re-decide 'sequence' / 'doc' rows (never 'seen' ones)
 *        [--csv]                exports/repairs/collabbox-booked-at-<ts>.csv: one row per document whose
 *                               booking day differs (DocNumber, type, department, doc / booked day, basis)
 *   node scripts/backfill-collabbox-booked-at.mjs --apply --expect ledger=N,orders=M --actor <email>
 *        [--redecide] [--outside-quiet-window]
 *   node scripts/backfill-collabbox-booked-at.mjs --rollback --run <id> --actor <email>
 *
 * WHAT IT DECIDES — booked_at + booked_at_basis per document, by the SAME rule the ledger uses for a
 * new document (public.collabbox_estimate_booked_at; its JS twin scripts/lib/collabbox-booking-day.mjs
 * decides in a dry run before the migration exists, and once it exists the dry run proves both agree
 * on every document): 'seen' (a full pass that had read its day missed it, the next one saw it),
 * 'sequence' (the per-series DocNumber order), 'doc' (= doc_at).
 *
 * WHAT MOVES — only what public.collabbox_sale_at() moves: a sale's day moves to its booking day only
 * when that day is on/after collabbox_booking_day_since() (the owner's default: 01.10.2026 — closed
 * months never move, nothing moves INTO September). So with the default the figures of September and
 * earlier do not change at all: booked_at there is information. The dry run also prints what WOULD
 * move with an earlier cutoff (--since, and the 01.09 / 01.03 what-ifs) — the owner's question.
 *
 * WRITES (--apply only; needs the migration, the quiet window 20:55–07:00 Skopje and no collabBox pass
 * running): ledger-first — data_repair_runs (key collabbox-booked-at) + one data_repair_rows row per
 * change (before / after) in the SAME transaction as the change:
 *   rule 'ledger'           collabbox_documents.booked_at / booked_at_basis (NULL → decided; with
 *                           --redecide also sequence/doc → re-decided), under
 *                           SET LOCAL elyon.collabbox_booked_at_backfill = 'on' (the write-once guard);
 *   rule 'order_sale_time'  the order each document IS (external_source collabbox + its DocNumber —
 *                           made by the sync or a history importer) whose sale time moves (sold_at /
 *                           confirmed_at / created_at still on doc_at's day → the sale time), and the
 *                           LEADS / LEADS-OUT holders the sync credited (sold_at only, the
 *                           collabbox_credit_order month rule), under elyon.allow_sold_change,
 *                           elyon.keep_updated_at (GET /call-agains reads updated_at) and
 *                           elyon.bulk_repair. ≤ 2.000 documents per transaction.
 * --rollback --run <id> restores every row whose current value still equals its "after".
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards; the token can write Bulgaria too). Never run during a
 * collabBox pass (07:00–22:59 and 00:00) — it would wait on the writer's row locks.
 */
import { pathToFileURL } from 'node:url';
import {
  bold, green, yellow, die, warn, ok, mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt,
  requireQuietWindow, requireNoSegmentRecompute, resolveActor, parseArgs, parseExpect, checkDrift,
  expectString, printTable, q, qUuid, qJson, qTextArray, fileStamp, writeCsv, fmtMkd,
} from './lib/repair-kit.mjs';
import { estimateAll, saleAt, skopjeDay, skopjeInstant } from './lib/collabbox-booking-day.mjs';

export const KEY = 'collabbox-booked-at';
const DEFAULT_SINCE = '2026-10-01';
const CHUNK = 2000;
const SALE_TYPES = new Set(['10036', '10050', '10106', '10055', '10114', '10111']);

// ── pure: what changes ───────────────────────────────────────────────────────
/**
 * docs: [{ doc_number, type, dept, outcome, doc_at, first_seen_at, first_run_id, booked_at, basis,
 *          amount_mkd, waiting }] (epoch seconds); est: Map doc → { booked_at, basis };
 * since: epoch seconds of the cutoff; redecide: re-decide sequence/doc rows.
 * → { changes: [{ doc, old, new }], months: {YYYY-MM: {...}}, moved: [{ doc, dept, from_day, to_day, waiting, amount }] }
 */
export function planLedger(docs, est, { since, redecide = false } = {}) {
  const changes = [];
  const months = {};
  const moved = [];
  for (const d of docs) {
    const e = est.get(d.doc_number);
    if (!e) continue;
    const m = skopjeDay(d.doc_at).slice(0, 7);
    const row = months[m] ?? (months[m] = { docs: 0, seen: 0, sequence: 0, doc: 0, day_differs: 0, sales_day_differs: 0, moves_under_cutoff: 0 });
    row.docs++;
    row[e.basis]++;
    const differs = skopjeDay(e.booked_at) !== skopjeDay(d.doc_at);
    if (differs) { row.day_differs++; if (SALE_TYPES.has(d.type)) row.sales_day_differs++; }
    const open = d.booked_at == null || (redecide && (d.basis === 'sequence' || d.basis === 'doc'));
    const current = d.booked_at ?? null;
    if (open && (current !== e.booked_at || (d.basis ?? null) !== e.basis)) {
      changes.push({ doc: d.doc_number, old: { booked_at: current, basis: d.basis ?? null }, new: e });
    }
    const before = saleAt(d.doc_at, current, since);
    const after = saleAt(d.doc_at, open ? e.booked_at : current, since);
    if (SALE_TYPES.has(d.type) && skopjeDay(before) !== skopjeDay(after)) {
      row.moves_under_cutoff++;
      moved.push({ doc: d.doc_number, type: d.type, dept: d.dept, from_day: skopjeDay(before), to_day: skopjeDay(after),
        waiting: !!d.waiting, amount_mkd: Number(d.amount_mkd) || 0 });
    }
  }
  return { changes, months, moved };
}

/**
 * The orders whose sale time moves. orders: [{ id, doc_number, doc_at, created_by_sync (= the document IS
 * the order: external_source collabbox + its DocNumber, made by the sync or a history importer), credited,
 * sold_at, sold_via, confirmed_at, created_at, cohort_at }] (epoch seconds); newBooked: Map doc → booked_at.
 * The document's own order: each of sold_at / confirmed_at / created_at still on doc_at's Skopje day → the sale time.
 * A credited holder (LEADS / LEADS-OUT): sold_at (via collabbox, = doc_at) → the sale time, only when it
 * stays in the Skopje month of the order's cohort day (collabbox_credit_order's rule).
 */
export function planOrders(orders, newBooked, { since }) {
  const out = [];
  for (const o of orders) {
    const b = newBooked.get(o.doc_number);
    if (b == null) continue;
    const t = saleAt(o.doc_at, b, since);
    if (t === o.doc_at) continue;
    const set = {};
    // "still the document's time": on the document's Skopje DAY (the history importers stamped the
    // day at 09:00 — the sync the exact document time); anything else was decided otherwise — kept
    const docDay = skopjeDay(o.doc_at);
    const onDocDay = (v) => v != null && skopjeDay(v) === docDay;
    if (o.created_by_sync) {
      if (onDocDay(o.sold_at)) set.sold_at = t;
      if (onDocDay(o.confirmed_at)) set.confirmed_at = t;
      if (onDocDay(o.created_at)) set.created_at = t;
    } else if (o.credited && o.sold_via === 'collabbox' && onDocDay(o.sold_at)
               && o.cohort_at != null && skopjeDay(t).slice(0, 7) === skopjeDay(o.cohort_at).slice(0, 7)) {
      set.sold_at = t;
    }
    if (Object.keys(set).length) {
      out.push({ id: o.id, doc_number: o.doc_number, before: { sold_at: o.sold_at, confirmed_at: o.confirmed_at, created_at: o.created_at }, set });
    }
  }
  return out;
}

// ── loaders (read-only) ──────────────────────────────────────────────────────
async function schemaState() {
  const [s] = await sqlRead(`select
      to_regprocedure('public.collabbox_estimate_booked_at(text,timestamptz,timestamptz,uuid)') is not null as estimator,
      exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'collabbox_documents'
                and column_name = 'booked_at') as col,
      exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'collabbox_sync_runs'
                and column_name = 'ahead_to') as ahead,
      to_regprocedure('public.collabbox_booking_day_since()') is not null as has_since`);
  let since = null;
  if (s.has_since) {
    [{ since }] = await sqlRead(`select to_char(public.collabbox_booking_day_since() at time zone 'Europe/Skopje', 'YYYY-MM-DD') as since`);
  }
  return { applied: !!(s.estimator && s.col), ahead: !!s.ahead, since };
}

async function loadRuns(applied) {
  const rows = await sqlRead(`select id::text, kind, status, window_from::text as wf, window_to::text as wt,
      ${applied ? 'ahead_to::text' : 'NULL::text'} as at,
      extract(epoch from started_at)::bigint as st, extract(epoch from finished_at)::bigint as fi
    from public.collabbox_sync_runs order by started_at`);
  return rows.map((r) => ({ id: r.id, kind: r.kind, status: r.status, from: r.wf, to: r.wt, ahead_to: r.at,
    started: Number(r.st), finished: r.fi == null ? null : Number(r.fi) }));
}

async function loadDocs(applied) {
  const [span] = await sqlRead(`select to_char(min(doc_at) at time zone 'Europe/Skopje', 'YYYY-MM') a,
                                       to_char(max(doc_at) at time zone 'Europe/Skopje', 'YYYY-MM') b from public.collabbox_documents`);
  if (!span?.a) return [];
  const out = [];
  for (let m = span.a; m <= span.b; m = nextMonth(m)) {
    const rows = await sqlRead(`select d.doc_number, d.doc_type_id as type, d.outcome,
        public.cohort_order_source(d.department[1], d.department[2], d.doc_number) as dept,
        extract(epoch from d.doc_at)::bigint as doc_at, extract(epoch from d.first_seen_at)::bigint as first_seen_at,
        d.first_run_id::text, d.amount_mkd,
        ${applied ? 'extract(epoch from d.booked_at)::bigint' : 'NULL::bigint'} as booked_at,
        ${applied ? 'd.booked_at_basis' : 'NULL::text'} as basis,
        (d.outcome in ('booked', 'awaiting_parcel') and d.vanished_at is null and not d.is_storno and d.amount_mkd > 0) as waiting
      from public.collabbox_documents d
     where d.doc_at >= (timestamp '${m}-01' at time zone 'Europe/Skopje')
       and d.doc_at <  (timestamp '${nextMonth(m)}-01' at time zone 'Europe/Skopje')`);
    for (const r of rows) {
      out.push({ ...r, doc_at: Number(r.doc_at), first_seen_at: r.first_seen_at == null ? null : Number(r.first_seen_at),
        booked_at: r.booked_at == null ? null : Number(r.booked_at) });
    }
  }
  return out;
}
const nextMonth = (m) => { const [y, mo] = m.split('-').map(Number); return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`; };

/** The orders a document's sale time can move: sync-made ones, and holders credited by the document. */
async function loadOrders(docNumbers) {
  const out = [];
  for (let i = 0; i < docNumbers.length; i += 1000) {
    const part = docNumbers.slice(i, i + 1000);
    const rows = await sqlRead(`select o.id::text, d.doc_number, extract(epoch from d.doc_at)::bigint as doc_at,
        (o.external_source = 'collabbox' and o.external_order_id = d.doc_number) as created_by_sync,
        (o.external_order_id is distinct from d.doc_number and d.outcome in ('credited', 'recorded')
         and d.related_order_id = o.id and d.credit in ('stamped', 'stamped_no_person', 'person_filled')) as credited,
        extract(epoch from o.sold_at)::bigint as sold_at, o.sold_via,
        extract(epoch from o.confirmed_at)::bigint as confirmed_at, extract(epoch from o.created_at)::bigint as created_at,
        extract(epoch from coalesce((select max(l.decided_at) from public.altercpa_leads l
                                      where l.order_id = o.id and l.decision in ('approved', 'cancel_other')),
                                     o.confirmed_at, o.created_at))::bigint as cohort_at
      from public.collabbox_documents d
      join public.orders o on (o.external_source = 'collabbox' and o.external_order_id = d.doc_number)
                           or o.id = d.related_order_id
     where d.doc_number = any(${qTextArray(part)})`);
    for (const r of rows) {
      out.push({ ...r, doc_at: Number(r.doc_at), sold_at: r.sold_at == null ? null : Number(r.sold_at),
        confirmed_at: r.confirmed_at == null ? null : Number(r.confirmed_at), created_at: Number(r.created_at),
        cohort_at: r.cohort_at == null ? null : Number(r.cohort_at) });
    }
  }
  return out.filter((o) => o.created_by_sync || o.credited);
}

/** Once the migration exists: the database's own decision for every document (parity with the twin). */
async function sqlEstimates(docs) {
  const out = new Map();
  const months = [...new Set(docs.map((d) => skopjeDay(d.doc_at).slice(0, 7)))].sort();
  for (const m of months) {
    const rows = await sqlRead(`select d.doc_number, extract(epoch from e.booked_at)::bigint as b, e.basis
      from public.collabbox_documents d
      cross join lateral public.collabbox_estimate_booked_at(d.doc_number, d.doc_at, d.first_seen_at, d.first_run_id) e
     where d.doc_at >= (timestamp '${m}-01' at time zone 'Europe/Skopje')
       and d.doc_at <  (timestamp '${nextMonth(m)}-01' at time zone 'Europe/Skopje')`);
    for (const r of rows) out.set(r.doc_number, { booked_at: Number(r.b), basis: r.basis });
  }
  return out;
}

const sinceEpoch = (ymd) => skopjeInstant(ymd, 0);

function summarizeMoved(moved) {
  const byDay = {};
  for (const m of moved) {
    for (const [day, sign] of [[m.from_day, -1], [m.to_day, 1]]) {
      const k = `${day}|${m.dept ?? '—'}`;
      const r = byDay[k] ?? (byDay[k] = { day, department: m.dept ?? '—', sales: 0, value_mkd: 0, waiting_bookings: 0 });
      r.sales += sign;
      r.value_mkd += sign * m.amount_mkd;
      if (m.waiting) r.waiting_bookings += sign;
    }
  }
  return Object.values(byDay).filter((r) => r.sales !== 0).sort((a, b) => a.day.localeCompare(b.day) || a.department.localeCompare(b.department));
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'rollback', 'redecide', 'csv', 'outside-quiet-window'],
    values: ['since', 'expect', 'actor', 'run'],
  });
  if (args.apply && args.rollback) die('--apply and --rollback are exclusive');
  mkGuard();
  await assertRemoteIsMk();
  if (args.rollback) return rollback(args);

  const state = await schemaState();
  const sinceYmd = args.since ?? state.since ?? DEFAULT_SINCE;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceYmd)) die('--since must be YYYY-MM-DD');
  if (args.apply && !state.applied) die('the migration 20260944000500 is not applied — --apply needs collabbox_estimate_booked_at().');
  if (args.apply && args.since && args.since !== state.since) die(`--since ${args.since} differs from the database's collabbox_booking_day_since() (${state.since}) — the database decides.`);
  console.log(bold(`\ncollabBox booking day — ${args.apply ? 'APPLY' : 'DRY RUN (read-only)'} · migration ${state.applied ? 'applied' : 'NOT applied (the JS twin decides)'} · cutoff ${sinceYmd}`));

  const [runs, docs] = await Promise.all([loadRuns(state.applied), loadDocs(state.applied)]);
  ok(`${docs.length.toLocaleString('de-DE')} ledger documents, ${runs.length} sync runs`);
  const js = estimateAll(docs, runs);
  let est = js;
  if (state.applied) {
    const db = await sqlEstimates(docs);
    let same = 0; const diff = [];
    for (const d of docs) {
      const a = js.get(d.doc_number), b = db.get(d.doc_number);
      if (a && b && a.booked_at === b.booked_at && a.basis === b.basis) same++; else if (diff.length < 10) diff.push(d.doc_number);
    }
    if (same === docs.length) ok(`the database and its JS twin decide every document alike (${same})`);
    else warn(`the database and the JS twin differ on ${docs.length - same} documents (e.g. ${diff.join(', ')}) — the database decides`);
    est = db;
  }

  const since = sinceEpoch(sinceYmd);
  const plan = planLedger(docs, est, { since, redecide: !!args.redecide });
  const newBooked = new Map(docs.map((d) => [d.doc_number, d.booked_at]));
  for (const c of plan.changes) newBooked.set(c.doc, c.new.booked_at);
  const orders = await loadOrders(docs.filter((d) => SALE_TYPES.has(d.type)).map((d) => d.doc_number));
  const orderPlan = planOrders(orders, newBooked, { since });

  console.log(bold('\nPer document month (doc_at): how each booking day is decided, and how many differ from the dispatch day'));
  printTable(Object.entries(plan.months).sort().map(([month, r]) => ({ month, ...r })),
    ['month', 'docs', 'seen', 'sequence', 'doc', 'day_differs', 'sales_day_differs', 'moves_under_cutoff']);
  console.log(`\n${bold('Ledger rows to write:')} ${plan.changes.length.toLocaleString('de-DE')} · ${bold('orders whose sale time moves:')} ${orderPlan.length}`);
  const moved = summarizeMoved(plan.moved);
  console.log(bold(`\nSales that change day under the cutoff ${sinceYmd} (bookings + orders, by day and department)`));
  if (moved.length) printTable(moved.map((r) => ({ ...r, value_mkd: fmtMkd(r.value_mkd) })), ['day', 'department', 'sales', 'value_mkd', 'waiting_bookings']);
  else console.log('  none — no figure moves (booked_at is information only below the cutoff)');

  // the owner's question: what an earlier cutoff would move
  for (const what of ['2026-09-01', '2026-03-01'].filter((w) => w < sinceYmd)) {
    const p = planLedger(docs, est, { since: sinceEpoch(what), redecide: !!args.redecide });
    const perMonth = {};
    for (const m of p.moved) {
      const month = m.from_day.slice(0, 7);
      const k = `${month}|${m.dept ?? '—'}`;
      const r = perMonth[k] ?? (perMonth[k] = { month, department: m.dept ?? '—', sales: 0, into_previous_month: 0, still_waiting: 0, value_mkd: 0 });
      r.sales++;
      r.value_mkd += m.amount_mkd;
      if (m.to_day.slice(0, 7) !== month) r.into_previous_month++;
      if (m.waiting) r.still_waiting++;
    }
    const nb = new Map(docs.map((d) => [d.doc_number, d.booked_at]));
    for (const c of p.changes) nb.set(c.doc, c.new.booked_at);
    const ord = planOrders(orders, nb, { since: sinceEpoch(what) });
    console.log(bold(`\nWHAT-IF the cutoff were ${what}: ${p.moved.length.toLocaleString('de-DE')} sales change day, ${ord.length.toLocaleString('de-DE')} orders re-stamped`));
    printTable(Object.values(perMonth).sort((a, b) => a.month.localeCompare(b.month) || a.department.localeCompare(b.department))
      .map((r) => ({ ...r, value_mkd: fmtMkd(r.value_mkd) })), ['month', 'department', 'sales', 'into_previous_month', 'still_waiting', 'value_mkd']);
  }

  if (args.csv) {
    const rows = docs.filter((d) => SALE_TYPES.has(d.type)).map((d) => ({ d, e: est.get(d.doc_number) }))
      .filter(({ d, e }) => e && skopjeDay(e.booked_at) !== skopjeDay(d.doc_at))
      .map(({ d, e }) => ({ doc_number: d.doc_number, type: d.type, department: d.dept, doc_day: skopjeDay(d.doc_at), booked_day: skopjeDay(e.booked_at), basis: e.basis, outcome: d.outcome }));
    ok(`CSV: ${writeCsv(`${KEY}-${fileStamp()}.csv`, rows)}`);
  }
  const counts = { ledger: plan.changes.length, orders: orderPlan.length };
  console.log(`\n${bold('Expect:')} --expect ${expectString(counts, ['ledger', 'orders'])}`);
  if (!args.apply) {
    console.log(yellow('\nDRY RUN — nothing was written. Apply (after the owner\'s OK, in the quiet window, no collabBox pass running):'));
    console.log(`  node scripts/backfill-collabbox-booked-at.mjs --apply --expect ${expectString(counts, ['ledger', 'orders'])} --actor <email>${args.redecide ? ' --redecide' : ''}\n`);
    return;
  }
  await apply(args, counts, plan, orderPlan, sinceYmd);
}

async function requireNoSyncRunning() {
  const [r] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
  if (r.n) die('a collabBox sync run is in progress — wait for it (the writer holds the ledger rows), then re-run.');
}

async function apply(args, counts, plan, orderPlan, sinceYmd) {
  if (!args.expect) die('--apply needs --expect ledger=N,orders=M (from the dry run you reviewed)');
  if (!args.actor) die('--apply needs --actor <email> (recorded in audit_log)');
  const actor = await resolveActor(args.actor);
  const drift = checkDrift(counts, parseExpect(args.expect, { ledger: 0, orders: 0 }));
  printTable(drift.rows, ['bucket', 'expected', 'actual', 'tolerance', 'check']);
  if (!drift.pass) die('the candidate set drifted from the reviewed dry run — re-run the dry run and review it again.');
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('apply');
  await requireNoSyncRunning();

  const [run] = await sql(`insert into public.data_repair_runs (key, dry_run, summary)
    values (${q(KEY)}, false, ${qJson({ counts, since: sinceYmd, redecide: !!args.redecide })}) returning id`);
  ok(`run ${run.id}`);
  const docs = plan.changes.map((c) => c.doc);
  let ledgerN = 0, orderN = 0;
  // 1. the ledger, ledger-first: the log rows and the change in ONE transaction (one API call); the
  //    database's own estimator decides (the dry run proved it equals what was reviewed)
  for (let i = 0; i < docs.length; i += CHUNK) {
    const part = docs.slice(i, i + CHUNK);
    await requireNoSyncRunning();
    const [r] = await sql(`
      SET LOCAL elyon.collabbox_booked_at_backfill = 'on';
      WITH cand AS (
        SELECT d.doc_number, d.booked_at AS old_b, d.booked_at_basis AS old_k, e.booked_at AS new_b, e.basis AS new_k
          FROM public.collabbox_documents d
          CROSS JOIN LATERAL public.collabbox_estimate_booked_at(d.doc_number, d.doc_at, d.first_seen_at, d.first_run_id) e
         WHERE d.doc_number = ANY (${qTextArray(part)})
           AND (d.booked_at IS NULL ${args.redecide ? "OR d.booked_at_basis IN ('sequence', 'doc')" : ''})
           AND (d.booked_at IS DISTINCT FROM e.booked_at OR d.booked_at_basis IS DISTINCT FROM e.basis)
      ), logged AS (
        INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
        SELECT ${qUuid(run.id)}, NULL, 'ledger', jsonb_build_object('booked_at', c.old_b, 'booked_at_basis', c.old_k),
               jsonb_build_object('booked_at', c.new_b, 'booked_at_basis', c.new_k), jsonb_build_object('doc_number', c.doc_number)
          FROM cand c
        RETURNING 1
      ), upd AS (
        UPDATE public.collabbox_documents d SET booked_at = c.new_b, booked_at_basis = c.new_k
          FROM cand c WHERE d.doc_number = c.doc_number
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM logged)::int AS logged, (SELECT count(*) FROM upd)::int AS updated;`);
    ledgerN += r.updated;
    console.log(`  ledger chunk ${Math.floor(i / CHUNK) + 1}: ${green('committed')} — ${ledgerN}`);
  }
  // 2. the orders whose sale time moves — re-checked in SQL against the ledger just written: a value
  //    moves only while it still equals doc_at; a credited holder only within its cohort month
  const want = orderPlan.map((o) => ({ id: o.id, doc: o.doc_number }));
  for (let i = 0; i < want.length; i += 500) {
    await requireNoSyncRunning();
    const [o] = await sql(`
      SET LOCAL elyon.keep_updated_at = 'on';
      SET LOCAL elyon.allow_sold_change = 'on';
      SET LOCAL elyon.bulk_repair = 'on';
      WITH want AS (
        SELECT x.id::uuid AS id, x.doc AS doc_number
          FROM jsonb_to_recordset(${qJson(want.slice(i, i + 500))}) AS x(id text, doc text)
      ), base AS (
        SELECT o.id, o.sold_at, o.sold_via, o.confirmed_at, o.created_at, d.doc_at,
               (o.external_source = 'collabbox' AND o.external_order_id = d.doc_number) AS by_sync,   -- the document IS the order
               public.collabbox_sale_at(d.doc_at, d.booked_at) AS t,
               coalesce((SELECT max(l.decided_at) FROM public.altercpa_leads l
                          WHERE l.order_id = o.id AND l.decision IN ('approved', 'cancel_other')),
                        o.confirmed_at, o.created_at) AS cohort_at
          FROM want w
          JOIN public.collabbox_documents d ON d.doc_number = w.doc_number
          JOIN public.orders o ON o.id = w.id
      ), cand AS (   -- "still the document's time" = on doc_at's Skopje day (importers stamped 09:00)
        SELECT b.*,
               CASE WHEN (b.sold_at AT TIME ZONE 'Europe/Skopje')::date = (b.doc_at AT TIME ZONE 'Europe/Skopje')::date
                         AND (b.by_sync OR (b.sold_via = 'collabbox'
                              AND to_char(b.t AT TIME ZONE 'Europe/Skopje', 'YYYY-MM') = to_char(b.cohort_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM')))
                    THEN b.t ELSE b.sold_at END AS new_sold,
               CASE WHEN b.by_sync AND (b.confirmed_at AT TIME ZONE 'Europe/Skopje')::date = (b.doc_at AT TIME ZONE 'Europe/Skopje')::date
                    THEN b.t ELSE b.confirmed_at END AS new_conf,
               CASE WHEN b.by_sync AND (b.created_at AT TIME ZONE 'Europe/Skopje')::date = (b.doc_at AT TIME ZONE 'Europe/Skopje')::date
                    THEN b.t ELSE b.created_at END AS new_created
          FROM base b
         WHERE b.t <> b.doc_at
      ), moving AS (
        SELECT c.* FROM cand c
         WHERE c.new_sold IS DISTINCT FROM c.sold_at OR c.new_conf IS DISTINCT FROM c.confirmed_at
            OR c.new_created IS DISTINCT FROM c.created_at
      ), logged AS (
        INSERT INTO public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
        SELECT ${qUuid(run.id)}, m.id, 'order_sale_time',
               jsonb_build_object('sold_at', m.sold_at, 'confirmed_at', m.confirmed_at, 'created_at', m.created_at),
               jsonb_build_object('sold_at', m.new_sold, 'confirmed_at', m.new_conf, 'created_at', m.new_created),
               jsonb_build_object('doc_at', m.doc_at, 'sale_at', m.t, 'by_sync', m.by_sync)
          FROM moving m
        RETURNING 1
      ), upd AS (
        UPDATE public.orders o SET sold_at = m.new_sold, confirmed_at = m.new_conf, created_at = m.new_created
          FROM moving m WHERE o.id = m.id
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM logged)::int AS logged, (SELECT count(*) FROM upd)::int AS updated;`);
    orderN += o.updated;
    console.log(`  orders chunk ${Math.floor(i / 500) + 1}: ${green('committed')} — ${orderN}`);
  }
  const payload = { ledger: ledgerN, orders: orderN, since: sinceYmd, redecide: !!args.redecide };
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
           summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${qJson(payload)})
     where id = ${qUuid(run.id)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(run.id)}, ${q(KEY)}, ${qJson(payload)});`);
  ok(`applied: ${ledgerN} ledger rows, ${orderN} orders (run ${run.id}; undo: --rollback --run ${run.id})`);
  console.log(yellow('  Next: node scripts/verify-booking-day.mjs · node scripts/verify-insights-ties.mjs · node scripts/verify-leaderboard-v2.mjs\n'));
}

async function rollback(args) {
  if (!args.run || !args.actor) die('--rollback needs --run <id> and --actor <email>');
  const actor = await resolveActor(args.actor);
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
  if (!run || run.key !== KEY) die(`run ${args.run} is not a ${KEY} run`);
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSyncRunning();
  // only rows whose current value still equals what the run wrote ("after") go back
  const [r] = await sql(`
    SET LOCAL elyon.collabbox_booked_at_backfill = 'on';
    SET LOCAL elyon.keep_updated_at = 'on';
    SET LOCAL elyon.allow_sold_change = 'on';
    SET LOCAL elyon.bulk_repair = 'on';
    WITH led AS (
      UPDATE public.collabbox_documents d
         SET booked_at = (x.before ->> 'booked_at')::timestamptz, booked_at_basis = x.before ->> 'booked_at_basis'
        FROM public.data_repair_rows x
       WHERE x.run_id = ${qUuid(args.run)} AND x.rule = 'ledger' AND d.doc_number = x.evidence ->> 'doc_number'
         AND d.booked_at IS NOT DISTINCT FROM (x.after ->> 'booked_at')::timestamptz
      RETURNING 1
    ), ord AS (
      UPDATE public.orders o
         SET sold_at = (x.before ->> 'sold_at')::timestamptz, confirmed_at = (x.before ->> 'confirmed_at')::timestamptz,
             created_at = (x.before ->> 'created_at')::timestamptz
        FROM public.data_repair_rows x
       WHERE x.run_id = ${qUuid(args.run)} AND x.rule = 'order_sale_time' AND o.id = x.order_id
         AND o.sold_at IS NOT DISTINCT FROM (x.after ->> 'sold_at')::timestamptz
         AND o.confirmed_at IS NOT DISTINCT FROM (x.after ->> 'confirmed_at')::timestamptz
         AND o.created_at IS NOT DISTINCT FROM (x.after ->> 'created_at')::timestamptz
      RETURNING 1
    )
    SELECT (SELECT count(*) FROM led)::int AS ledger, (SELECT count(*) FROM ord)::int AS orders;`);
  const payload = { rolled_back_run: args.run, ledger: r.ledger, orders: r.orders };
  await sql(`update public.data_repair_runs set summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('rolled_back', ${qJson({ ...payload, at: new Date().toISOString() })})
     where id = ${qUuid(args.run)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(payload)});`);
  ok(`rolled back: ${r.ledger} ledger rows, ${r.orders} orders`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
