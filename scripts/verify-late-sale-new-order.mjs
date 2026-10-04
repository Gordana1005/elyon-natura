/**
 * verify-late-sale-new-order — READ-ONLY proof of the owner's rule of 03.10.2026 ("ДА"): a collabBox sales document /
 * MEX parcel that arrived more than 10 days after an existing order's cancel / trash, or after its own sale, is a NEW
 * order on the booking day (migrations 20260947002000 / 2010 / 2020 / 2030; scripts/repair-late-sale-new-order.mjs).
 *
 *   node scripts/verify-late-sale-new-order.mjs [--list]
 *
 *   W1  the live functions carry the rule: late_sale_classify / _plan / _release / _undo exist, the writer
 *       (collabbox_apply_one) has the late branch, collabbox_credit_order refuses a late holder, sale_day_revive_plan
 *       moves case 1 / 2 only; the switch app_settings.late_sale_new_order (report = flags only · apply = splits)
 *   L1  no case 3 left: late_sale_plan() — every order still holding a late document / parcel. Once the history repair
 *       is applied, a unit that is not in that run's own "manual" list (no sales document, a twin, value 0 …) FAILS;
 *       before it, the units are listed as PENDING
 *   L2  every new order (late_sale_moves, not undone) is the document's order: external ref = parcel = its
 *       mex_tracking_id, credited (sold_by_ext = the document's author whenever the document has one), sold_at =
 *       created_at = confirmed_at = the document's sale time (collabbox_sale_at — the booking), never a lead
 *       (sale_source ≠ altercpa), its department = the seller's team (order_dept_by_team) or the folder's mapping
 *   L3  no parcel held twice: exactly one order names each moved parcel (the new one) and the register links it there
 *   L4  the old orders are restored: none holds the parcel any more; each is still in its released status (a later
 *       change by a person / rule is listed, not failed); a released dead order is not counted as a sale
 *   F1  forward (report mode): documents the writer flagged late_sale_pending in the last 14 days (INFO)
 *
 * Exit: 0 = no FAIL · 1 = a FAIL · 2 = refused / unreachable.
 * Safety: scripts/verify-insights-ties.mjs runSql — pinned to Macedonia, one SELECT / WITH per call, read_only: true.
 */
import { pathToFileURL } from 'node:url';
import { runSql } from './verify-insights-ties.mjs';

const n = (v) => Number(v ?? 0) || 0;
const fmt = (v) => Math.round(n(v)).toLocaleString('de-DE');
const results = [];
const add = (id, status, text, rows = []) => results.push({ id, status, text, rows });

async function main() {
  const list = process.argv.includes('--list');

  // ── W1 ──
  const [w] = await runSql(`select
      (select count(*) from pg_proc where proname in ('late_sale_classify', 'late_sale_plan', 'late_sale_release', 'late_sale_undo',
                                                      'late_sale_case_of', 'late_sale_attach_new', 'late_sale_dead_at'))::int as fns,
      (select position('late_sale_release' in prosrc) > 0 and position('collabbox_leads_late' in prosrc) > 0
         from pg_proc where proname = 'collabbox_apply_one') as writer,
      (select position('late_sale_case_of' in prosrc) > 0 from pg_proc where proname = 'collabbox_credit_order') as credit,
      (select position('late_sale_case_of' in prosrc) > 0 and position('''stale''' in prosrc) = 0
         from pg_proc where proname = 'sale_day_revive_plan') as revive,
      (select position('never had a MEX parcel of its own' in prosrc) > 0 from pg_proc where proname = 'late_sale_release') as release_unproven,
      (select value ->> 'mode' from public.app_settings where key = 'late_sale_new_order') as mode`);
  const wOk = w.fns === 7 && w.writer && w.credit && w.revive && w.release_unproven && ['report', 'apply'].includes(w.mode);
  add('W1', wOk ? 'PASS' : 'FAIL', `functions ${w.fns}/7 · writer ${w.writer} · credit ${w.credit} · revive plan ${w.revive} · release ${w.release_unproven} · switch ${w.mode}`);

  // ── L1 ──
  const plan = await runSql(`select p.order_id, p.display_id, p.kase, p.doc_type_id, p.doc_number is not null as has_doc, p.in_payout,
      p.tracking, p.value_mkd from public.late_sale_plan() p order by p.display_id`);
  const [run] = await runSql(`select id, applied_at, summary from public.data_repair_runs
     where key = 'late-sale-new-order' and dry_run and applied_at is not null order by applied_at desc limit 1`);
  if (!run) {
    add('L1', plan.length ? 'PENDING' : 'PASS', `${plan.length} case-3 units wait for the history repair (${plan.filter((p) => p.has_doc).length} with a sales document, ${fmt(plan.reduce((s, p) => s + n(p.value_mkd), 0))} ден); no applied run yet`,
      list ? plan.slice(0, 50) : []);
  } else {
    const manual = new Set((run.summary?.units || []).filter((u) => u.action === 'manual').map((u) => u.tracking));
    const left = plan.filter((p) => !manual.has(p.tracking));
    add('L1', left.length ? 'FAIL' : 'PASS', `${plan.length} case-3 units left: ${plan.length - left.length} on the run's own manual list, ${left.length} NOT (a new late link since — re-run the repair's dry run)`,
      left.slice(0, 50));
  }

  // ── L2 ──
  const l2 = await runSql(`select l.id, l.display_id as old_order, l.new_display_id, l.tracking, l.kase,
      n.id is not null as exists_, n.external_source, n.external_order_id = l.tracking as ext_ok, n.mex_tracking_id = l.tracking as trk_ok,
      d.author is not null as doc_has_author, n.sold_by_ext is not null as credited,
      n.sold_at = n.created_at and n.created_at = n.confirmed_at as one_time,
      n.sold_at = public.collabbox_sale_at(d.doc_at, least(coalesce(d.booked_at, d.doc_at), d.doc_at)) as booking_time,
      n.sale_source, n.sale_source_detail,
      public.cohort_order_source(n.sale_source, n.sale_source_detail, n.mex_tracking_id, n.dept_override) as dept,
      coalesce(public.order_dept_by_team(n.sale_source, n.sold_by_person_id, n.sold_at),
               public.cohort_order_source(n.sale_source, n.sale_source_detail, n.mex_tracking_id)) as dept_expected
    from public.late_sale_moves l
    left join public.orders n on n.id = l.new_order_id
    left join public.collabbox_documents d on d.doc_number = l.tracking
   where l.undone_at is null and l.new_order_id is not null`);
  const bad2 = l2.filter((r) => !r.exists_ || r.external_source !== 'collabbox' || !r.ext_ok || !r.trk_ok
    || (r.doc_has_author && !r.credited) || !r.one_time || !r.booking_time || r.sale_source === 'altercpa'
    || (r.dept !== r.dept_expected && !(r.dept === 'elyon_crm' && r.dept_expected === null)));
  add('L2', bad2.length ? 'FAIL' : (l2.length ? 'PASS' : 'INFO'),
    `${l2.length} new orders: every one the document's own order, credited, dated to its booking, never a lead, its team's department` +
    (l2.length ? ` — by department: ${Object.entries(l2.reduce((m, r) => ({ ...m, [r.dept]: (m[r.dept] || 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''),
    bad2.slice(0, 30));

  // ── L3 ──
  const l3 = await runSql(`select l.tracking, l.new_display_id,
      (select count(*) from public.orders x where x.mex_tracking_id = l.tracking)::int as namers,
      (select m.order_id = l.new_order_id from public.mex_parcels m where m.tracking_id = l.tracking) as register_ok
    from public.late_sale_moves l where l.undone_at is null and l.new_order_id is not null`);
  const bad3 = l3.filter((r) => r.namers !== 1 || !r.register_ok);
  add('L3', bad3.length ? 'FAIL' : (l3.length ? 'PASS' : 'INFO'), `${l3.length} moved parcels: each named by one order and linked to it in the register`, bad3.slice(0, 30));

  // ── L4 ──
  const l4 = await runSql(`select l.display_id, l.tracking, l.kase, l.after ->> 'status' as released, o.status::text as now_status,
      o.mex_tracking_id = l.tracking as still_holds,
      (select max(h.changed_by_name) from public.order_history h where h.order_id = o.id and h.changed_at > l.created_at
          and h.changed_by_name is distinct from 'System (late-sale:new-order)') as changed_by_since
    from public.late_sale_moves l join public.orders o on o.id = l.order_id
   where l.undone_at is null and l.new_order_id is not null`);
  const holds = l4.filter((r) => r.still_holds);
  const moved = l4.filter((r) => !r.still_holds && r.now_status !== r.released);
  add('L4', holds.length ? 'FAIL' : (l4.length ? 'PASS' : 'INFO'),
    `${l4.length} old orders: none holds its late parcel; ${l4.length - moved.length} still as released` +
    (moved.length ? `, ${moved.length} changed since by a person / rule (listed)` : '') +
    (l4.length ? ` — released as ${Object.entries(l4.reduce((m, r) => ({ ...m, [r.released]: (m[r.released] || 0) + 1 }), {})).map(([k, v]) => `${k} ${v}`).join(', ')}` : ''),
    [...holds, ...(list ? moved : [])].slice(0, 40));

  // ── L5 — the relinks (20260948000300): the late parcel went to the customer's own lead, not to a new order ──
  const l5 = await runSql(`select l.display_id, l.relink_display_id, l.tracking,
      o.mex_tracking_id is not distinct from l.tracking as holder_still_holds,
      n.mex_tracking_id is not distinct from l.tracking as lead_holds,
      (select m.order_id = l.relink_order_id from public.mex_parcels m where m.tracking_id = l.tracking) as register_ok,
      (select count(*) from public.orders x where x.mex_tracking_id = l.tracking)::int as namers,
      n.sale_source = 'altercpa' as lead_is_lead,
      public.cohort_order_source(n.sale_source, n.sale_source_detail, n.mex_tracking_id, n.dept_override) as dept,
      public.late_sale_case_of(n.id, l.tracking) as lead_case
    from public.late_sale_moves l join public.orders o on o.id = l.order_id join public.orders n on n.id = l.relink_order_id
   where l.undone_at is null and l.relink_order_id is not null`);
  const bad5 = l5.filter((r) => r.holder_still_holds || !r.lead_holds || !r.register_ok || r.namers !== 1
    || (r.lead_is_lead && r.dept !== 'altercpa') || ['dead_late', 'stale', 'second_sale'].includes(r.lead_case));
  add('L5', bad5.length ? 'FAIL' : (l5.length ? 'PASS' : 'INFO'),
    `${l5.length} relinked parcels: each on the customer's own lead (named once, linked in the register, a lead stays Тим Маџари In, never late for it), the old order released`,
    bad5.slice(0, 30));

  // ── F1 ──
  const [f1] = await runSql(`select count(*)::int as n from public.collabbox_documents
     where updated_at > now() - interval '14 days' and exists (select 1 from unnest(flags) f where f like 'late_sale_pending:%')`);
  const [f2] = await runSql(`select count(*)::int as n from public.late_sale_moves where scope = 'writer' and undone_at is null`);
  add('F1', 'INFO', `forward: ${f1.n} documents flagged late_sale_pending (report mode) in 14 days · ${f2.n} splits made by the writer itself`);

  for (const r of results) {
    console.log(`${r.status.padEnd(7)} ${r.id}  ${r.text}`);
    if (r.rows.length) console.table(r.rows);
  }
  const fail = results.some((r) => r.status === 'FAIL');
  console.log(`\n${fail ? 'FAIL' : 'PASS'} — ${results.length} checks\n`);
  process.exit(fail ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(e.stack || e.message || String(e)); process.exit(2); });
}
