/**
 * Repair — A LATE PARCEL THAT IS ANOTHER LEAD'S OWN SALE GOES TO THAT LEAD (owner, Mile, 04.10.2026 07:26 — "run
 * everything right now"). No shebang (repair-kit convention). Run with node.
 *
 * OWNER LAW: 03.10.2026 "a late document / parcel … cancelled / trashed ≤ 10 days before → that order's own sale
 * (revived, booking day)"; 01.10.2026 "the truth is MEX (+ collabBox), never AlterCPA" — the phone + date linker.
 * late_sale_plan() (20260947002000) looks only at the order that HOLDS a late parcel. Where the same customer has
 * ANOTHER lead that the phone + date linker would pick for that parcel if it were an orphan, the parcel is that lead's
 * sale (Тим Маџари In) — not a NEW Тим Маџари Out order (scripts/repair-late-sale-new-order.mjs holds these units back).
 *
 * WHICH lead: the LIVE body of public.link_lead_parcels_plan (rule 2 candidates, rule 2b exclusions, unique both
 * ways, product by name after 72 h, payout / affiliate safety) is run over the case-3 holders' parcels as if they
 * were orphans — one definition, nothing re-implemented here. Its `link` rows are relinked by
 * public.late_sale_relink() (20260948000300: late_sale_release of the holder → the lead takes the parcel as the
 * linker writes a link → the live collabBox writer re-credits the document); its `manual` rows stay for a person.
 *
 *   node scripts/repair-late-sale-relink.mjs [--expect units=152,link=115,manual=37]
 *        dry run → CSV in exports/neworder + a data_repair_runs dry-run row + the run id
 *   node scripts/repair-late-sale-relink.mjs --apply --run <id> [--actor mile@elyon.com] [--chunk 20] [--outside-quiet-window]
 *   node scripts/repair-late-sale-relink.mjs --rollback <id> [--apply] [--actor mile@elyon.com]
 *        undo: late_sale_relink_undo(<the apply's collabBox run>) — only where holder and lead are as the relink left them
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched; nothing is sent to AlterCPA.
 */
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MK_REF, ROOT, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireRepairSchema, requireKeepUpdatedAt, requireQuietWindow,
  requireNoSegmentRecompute, q, qUuid, qJson, qTextArray, isUuid, parseArgs, parseExpect, checkDrift, expectString,
  fmtMkd, fileStamp, resolveActor, recordDryRun, verifyRunForApply, finalizeRun, auditPartial, printTable,
  candidateHash, planLine,
} from './lib/repair-kit.mjs';
import { PLAN_SQL, DEPT_WORD } from './lib/late-sale-new-order.mjs';

export const KEY = 'late-sale-relink';
const EXPECTED = Object.freeze({ units: 152, link: 115, manual: 37 });
const CHUNK = 20;
const OUT_DIR = join(ROOT, 'exports', 'neworder');

function writeCsvHere(name, rows) {
  mkdirSync(OUT_DIR, { recursive: true });
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const path = join(OUT_DIR, name);
  writeFileSync(path, [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n'), 'utf8');
  return path;
}

/** The live linker rules over the given parcels, as if they were orphans (read-only). */
async function linkerOver(trackings) {
  const [fn] = await sqlRead(`select prosrc from pg_proc where oid = to_regprocedure('public.link_lead_parcels_plan(integer)')`);
  if (!fn?.prosrc) die('public.link_lead_parcels_plan(integer) is missing.');
  let body = fn.prosrc.replace(/\r/g, '');
  const sub = (from, to) => {
    const n = body.split(from).length - 1;
    if (n !== 1) die(`the live linker body changed: expected exactly one "${from.slice(0, 60)}…", found ${n} — re-read 20260944000980 before using this script.`);
    body = body.replace(from, to);
  };
  sub('$1::integer', '400');
  sub('WHERE p.order_id IS NULL', `WHERE p.tracking_id = ANY (${qTextArray(trackings)})`);
  sub('AND NOT EXISTS (SELECT 1 FROM public.orders n WHERE n.mex_tracking_id = p.tracking_id)', '');
  const [res] = await sqlRead(`select (${body}) as r`);
  return res.r;
}

export async function classify() {
  const plan = await sqlRead(PLAN_SQL);
  const byTrack = new Map(plan.map((p) => [p.tracking, p]));
  if (!plan.length) return { plan, link: [], manual: [], lines: [], csv: [], counts: { units: 0, link: 0, manual: 0 }, why: {} };
  const r = await linkerOver([...byTrack.keys()]);
  // unique both ways across the WHOLE register: a picked lead must not also fit a true orphan parcel
  const leadIds = (r.link || []).map((x) => x.order_id);
  const clash = leadIds.length ? await sqlRead(`
    select o.id from public.orders o
      join public.mex_parcels p on p.order_id is null and p.phone8 = right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8)
       and o.created_at between p.created_at_mex - interval '10 days' and p.created_at_mex + interval '1 day'
       and coalesce(p.cod_mkd, 0) > 0 and (p.series in ('9110', '9103') or (coalesce(p.series, '') = '' and p.account = 'bio_natural'))
       and not exists (select 1 from public.orders n where n.mex_tracking_id = p.tracking_id)
     where o.id = any(array[${leadIds.map((i) => qUuid(i)).join(',')}]::uuid[])
     group by 1`) : [];
  const clashes = new Set(clash.map((c) => c.id));
  const link = [], manual = [], lines = [], csv = [], why = {};
  const add = (k) => { why[k] = (why[k] || 0) + 1; };
  for (const x of r.link || []) {
    const u = byTrack.get(x.tracking_id);
    let reason = '';
    if (!u) reason = 'parcel left the late-sale plan';
    else if (u.in_payout) reason = 'the holder is in agent_payout_items (payouts deferred by the owner)';
    else if (clashes.has(x.order_id)) reason = 'the lead also fits a true orphan parcel';
    const base = {
      holder: u?.display_id ?? '', kase: u?.kase ?? '', tracking: x.tracking_id, doc_type: u?.doc_type_id ?? '',
      value_mkd: u?.value_mkd ?? x.cod_mkd, month_holder: u?.month_before ?? '', month_doc: u?.month_after ?? '',
      dept_holder: DEPT_WORD[u?.dept_before] || u?.dept_before || '', lead: x.display_id, lead_status: x.status,
      target: x.target || '', kind: x.kind, hours: x.hours, mex_status: x.mex_status_id,
    };
    if (reason) {
      add(reason);
      manual.push({ tracking: x.tracking_id, reason });
      lines.push(planLine(u?.order_id ?? x.order_id, 'LR_manual', reason.slice(0, 40), x.tracking_id));
      csv.push({ ...base, action: 'manual', why: reason, candidates: '' });
      continue;
    }
    const line = planLine(u.order_id, 'LR_relink', `${x.status}>${x.target ?? '='}:${x.order_id}`, x.tracking_id);
    lines.push(line);
    link.push({ ...x, unit: u, line });
    csv.push({ ...base, action: 'relink', why: '', candidates: '' });
  }
  for (const m of r.manual || []) {
    const u = byTrack.get(m.tracking_id);
    add(m.reason);
    manual.push({ tracking: m.tracking_id, reason: m.reason });
    lines.push(planLine(u?.order_id ?? m.tracking_id, 'LR_manual', m.reason, m.tracking_id));
    csv.push({
      holder: u?.display_id ?? '', kase: u?.kase ?? '', tracking: m.tracking_id, doc_type: u?.doc_type_id ?? '',
      value_mkd: u?.value_mkd ?? m.cod_mkd, month_holder: u?.month_before ?? '', month_doc: u?.month_after ?? '',
      dept_holder: DEPT_WORD[u?.dept_before] || u?.dept_before || '', lead: '', lead_status: '', target: '', kind: '', hours: '',
      mex_status: m.mex_status_id, action: 'manual', why: m.reason,
      candidates: (m.orders || []).map((o) => `${o.display_id} ${o.status}${o.excluded ? ` (${o.excluded})` : ''}`).join(' / '),
    });
  }
  return { plan, link, manual, lines, csv, why, linker: r,
    counts: { units: link.length + manual.length, link: link.length, manual: manual.length } };
}

function buildApplySql({ runId, syncRun, units }) {
  const values = units.map((x) => `(${[qUuid(x.unit.order_id), q(x.tracking_id), q(x.unit.kase), qUuid(x.order_id), q(x.status), q(x.kind), q(x.line)].join(', ')})`);
  return `
set local statement_timeout = '170s';
set local lock_timeout = '20s';
create temp table _lr (holder uuid primary key, tracking text not null, kase text not null, lead uuid not null,
                       lead_status text not null, kind text not null, line text not null) on commit drop;
insert into _lr values
${values.join(',\n')};
create temp table _lr_out (holder uuid, tracking text, ok boolean, why text, lead_display text, target text) on commit drop;
do $lr$
declare
  r record;
  res jsonb;
begin
  for r in select * from _lr order by holder loop
    begin
      if not exists (select 1 from public.orders o where o.id = r.holder and o.mex_tracking_id = r.tracking)
         or public.late_sale_case_of(r.holder, r.tracking) is distinct from r.kase then
        insert into _lr_out values (r.holder, r.tracking, false, 'moved since the dry run', null, null);
        continue;
      end if;
      res := public.late_sale_relink(${qUuid(syncRun)}, r.holder, r.tracking, r.lead, r.kase, r.lead_status, r.kind);
      insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
      values (${qUuid(runId)}, r.holder, 'LR_relink', jsonb_build_object('move', res -> 'move'),
              jsonb_build_object('lead', r.lead, 'lead_display', res ->> 'lead_display', 'target', res ->> 'target'),
              jsonb_build_object('key', ${q(KEY)}, 'line', r.line, 'tracking', r.tracking, 'kase', r.kase, 'move', res -> 'move',
                                 'sync_run', ${q(syncRun)}, 'lead', r.lead, 'writer', res -> 'writer'));
      insert into _lr_out values (r.holder, r.tracking, true, null, res ->> 'lead_display', res ->> 'target');
    exception when others then
      insert into _lr_out values (r.holder, r.tracking, false, left(sqlerrm, 300), null, null);
    end;
  end loop;
end $lr$;
select (select count(*) from _lr)::int as planned, (select count(*) from _lr_out where ok)::int as applied,
       (select coalesce(jsonb_agg(jsonb_build_object('holder', holder, 'lead', lead_display, 'target', target)), '[]'::jsonb) from _lr_out where ok) as made,
       (select coalesce(jsonb_agg(jsonb_build_object('holder', holder, 'tracking', tracking, 'why', why)), '[]'::jsonb) from _lr_out where not ok) as skipped;`;
}

async function rollback(args) {
  const runId = args.rollback;
  if (!isUuid(runId)) die('--rollback needs the applied run id.');
  const [run] = await sqlRead(`select id, key, applied_at, summary from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run || run.key !== KEY) die(`run ${runId} is not a ${KEY} run.`);
  const syncRun = run.summary?.apply?.sync_run;
  if (!isUuid(syncRun)) die(`run ${runId} has no applied collabBox run in its summary (was it applied?).`);
  const rows = await sqlRead(`select l.id, l.display_id, l.relink_display_id, l.tracking,
      (o.status::text = l.after ->> 'status' and o.mex_tracking_id is not distinct from l.after ->> 'mex_tracking_id') as holder_same,
      (n.mex_tracking_id is not distinct from l.tracking and n.status::text = l.relink_after ->> 'status'
        and not exists (select 1 from public.order_history h where h.order_id = n.id and h.changed_by is not null and h.changed_at > l.created_at)) as lead_same
    from public.late_sale_moves l join public.orders o on o.id = l.order_id join public.orders n on n.id = l.relink_order_id
   where l.sync_run_id = ${qUuid(syncRun)} and l.undone_at is null and l.relink_order_id is not null`);
  const same = rows.filter((r) => r.holder_same && r.lead_same);
  console.log(`  relinks of collabBox run ${syncRun}: ${rows.length} · restorable: ${same.length} · left alone: ${rows.length - same.length}`);
  for (const r of rows.filter((x) => !(x.holder_same && x.lead_same)).slice(0, 30)) {
    console.log(`    ${r.display_id} / ${r.relink_display_id} ${r.tracking}: ${!r.holder_same ? 'the old order changed' : 'the lead changed'}`);
  }
  if (!args.apply) { console.log(`\nPreview only. To undo: node scripts/repair-late-sale-relink.mjs --rollback ${runId} --apply\n`); return; }
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireKeepUpdatedAt({ forApply: true });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rb = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rb)}, ${q(`rollback-${KEY}`)}, false, ${q(candidateHash(same.map((r) => `${r.id}:rollback`)))},
            ${qJson({ rolled_back_run: runId, sync_run: syncRun })})`);
  const [res] = await sql(`select public.late_sale_relink_undo(${qUuid(syncRun)}, ${q(actor.email)}) as r`);
  await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
      summary = summary || ${qJson({ restored: res.r.restored, skipped: res.r.skipped })} where id = ${qUuid(rb)};
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)},
            ${qJson({ rollback_run: rb, restored: res.r.restored, left_alone: (res.r.skipped || []).length })});`);
  ok(`undone: ${res.r.restored} relinks (rollback run ${rb}); left alone: ${(res.r.skipped || []).length}`);
  for (const s of res.r.skipped || []) console.log(yellow(`    move ${s.move} ${s.order}: ${s.why}`));
  console.log(yellow('  Next: node scripts/verify-late-sale-new-order.mjs · node scripts/engine-fixture-mk.mjs\n'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window', 'help'], values: ['run', 'expect', 'actor', 'chunk', 'rollback'],
  });
  if (args.help) { console.log('see the header of scripts/repair-late-sale-relink.mjs'); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair — ${KEY} — ${args.rollback ? 'ROLLBACK' : APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  await assertRemoteIsMk();
  if (args.rollback) { await rollback(args); return; }
  if (APPLY && !isUuid(args.run)) die('--apply needs --run <id> (printed by the dry run).');
  await requireRepairSchema({ forApply: APPLY });
  await requireKeepUpdatedAt({ forApply: APPLY });
  const [fn] = await sqlRead(`select to_regprocedure('public.late_sale_relink(uuid,uuid,text,uuid,text,text,text)') is not null as ok`);
  if (!fn?.ok) die('public.late_sale_relink is missing — apply 20260948000300 first.');
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the apply'); }
  const plan = await classify();

  // ── report ──
  const tally = (list, f) => { const o = {}; for (const x of list) { const k = f(x); o[k] ??= { n: 0, mkd: 0 }; o[k].n++; o[k].mkd += Number(x.unit?.value_mkd ?? 0); } return Object.entries(o).sort().map(([k, v]) => ({ k, n: v.n, 'ден': fmtMkd(v.mkd) })); };
  console.log(bold(`Late-sale plan now: ${plan.plan.length} holders · the linker rule: ${plan.linker?.rule ?? '-'}`));
  console.log(bold('\nRelink — the lead takes the parcel (the status follows MEX)'));
  printTable(tally(plan.link, (x) => `${x.status} → ${x.target ?? '(stays)'}`).map((r) => ({ 'lead status → target': r.k, units: r.n, 'ден': r['ден'] })));
  console.log(bold('… by the holder\'s case · department today (the sale stays / becomes Тим Маџари In on the lead)'));
  printTable(tally(plan.link, (x) => `${x.unit.kase} · ${DEPT_WORD[x.unit.dept_before] || x.unit.dept_before}`).map((r) => ({ 'case · holder department': r.k, units: r.n, 'ден': r['ден'] })));
  console.log(bold('… by document month'));
  printTable(tally(plan.link, (x) => x.unit.month_after || '?').map((r) => ({ month: r.k, units: r.n, 'ден': r['ден'] })));
  console.log(bold('Left alone (manual) — why'));
  printTable(Object.entries(plan.why).sort((a, b) => b[1] - a[1]).map(([reason, n]) => ({ reason, n })));

  const stamp = fileStamp();
  const csvPath = writeCsvHere(`${KEY}-${APPLY ? 'apply-' : ''}${stamp}.csv`, plan.csv);
  ok(`CSV (display ids, no phones): ${csvPath}`);

  if (!APPLY) {
    const drift = checkDrift(plan.counts, parseExpect(args.expect, EXPECTED));
    printTable(drift.rows);
    if (!drift.pass) die(`Counts drifted — NO run recorded. If understood, re-run with --expect ${expectString(plan.counts, Object.keys(EXPECTED))}`);
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary: {
      script: 'repair-late-sale-relink.mjs', counts: plan.counts, manual_why: plan.why, linker_counts: plan.linker?.counts ?? null,
      units: plan.csv.map((r) => ({ holder: r.holder, action: r.action, kase: r.kase, tracking: r.tracking, lead: r.lead || null, target: r.target || null, why: r.why || null })),
      csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n` +
      `  node scripts/assert-mk-target.mjs && node scripts/repair-late-sale-relink.mjs --apply --run ${id}\n`);
    return;
  }

  // ── apply ──
  const [busy] = await sqlRead(`select count(*)::int n from public.collabbox_sync_runs where status = 'running' and started_at > now() - interval '20 minutes'`);
  if (busy.n) die('a collabBox pass is running (collabbox_sync_runs) — the writer runs one pass at a time; retry when it finished.');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines });
  const units = plan.link.filter((x) => !done.has(x.unit.order_id));
  const days = units.map((x) => x.unit.doc_sale_at).filter(Boolean).sort();
  const [sr] = await sql(`insert into public.collabbox_sync_runs (kind, trigger_kind, status, window_from, window_to, doc_types, stats)
    values ('manual', 'manual', 'running', ${q(String(days[0] ?? new Date().toISOString()).slice(0, 10))}::date,
            ${q(String(days[days.length - 1] ?? new Date().toISOString()).slice(0, 10))}::date,
            ${qTextArray(['10111', '10114'])},
            ${qJson({ tool: 'scripts/repair-late-sale-relink.mjs', repair_run: args.run })}) returning id`);
  ok(`collabbox_sync_runs ${sr.id} (manual, running) carries the writer's re-credits`);
  const size = Math.max(1, Math.min(CHUNK, Number(args.chunk) || CHUNK));
  const stats = { applied: 0, made: [], skipped: [], failed: null };
  const t0 = Date.now();
  for (let i = 0; i < units.length; i += size) {
    const chunk = units.slice(i, i + size);
    process.stdout.write(`  chunk ${i / size + 1}/${Math.ceil(units.length / size)} (${chunk.length} units) … `);
    try {
      await requireNoSegmentRecompute('start the next chunk');
      const [res] = await sql(buildApplySql({ runId: args.run, syncRun: sr.id, units: chunk }));
      stats.applied += res.applied;
      stats.made.push(...(res.made || []));
      stats.skipped.push(...(res.skipped || []));
      console.log(`${green('committed')} ${res.applied}/${res.planned}${(res.skipped || []).length ? yellow(` (${res.skipped.length} left alone)`) : ''}`);
    } catch (e) {
      console.log('FAILED — rolled back');
      stats.failed = { chunk: i / size + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(stats.failed.error);
      break;
    }
  }
  await sql(`update public.collabbox_sync_runs set status = ${q(stats.failed ? 'failed' : 'ok')}, error = ${q(stats.failed?.error ?? null)},
      finished_at = now(), duration_ms = ${Date.now() - t0}, stats = stats || ${qJson({ relinked: stats.made.length, skipped: stats.skipped })}
    where id = ${qUuid(sr.id)}`);
  for (const s of stats.skipped) console.log(yellow(`    left alone ${s.tracking}: ${s.why}`));
  const payload = { script: 'repair-late-sale-relink.mjs', counts: plan.counts, applied_units: stats.applied, sync_run: sr.id,
    skipped: stats.skipped, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; committed units are in the ledger — fix the cause and re-run the same --apply.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} late parcels went to their own lead (collabBox run ${sr.id})`);
  const [v] = await sqlRead(`select
      (select count(*) from public.late_sale_moves where sync_run_id = ${qUuid(sr.id)} and undone_at is null and relink_order_id is not null)::int as relinks,
      (select count(*) from public.late_sale_moves l join public.orders o on o.id = l.order_id
        where l.sync_run_id = ${qUuid(sr.id)} and o.mex_tracking_id is not distinct from l.tracking)::int as holder_still_holds,
      (select count(*) from public.late_sale_moves l join public.orders n on n.id = l.relink_order_id
        where l.sync_run_id = ${qUuid(sr.id)} and n.mex_tracking_id is distinct from l.tracking)::int as lead_not_holding,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null group by 1 having count(*) > 1) d
        where d.mex_tracking_id in (select tracking from public.late_sale_moves where sync_run_id = ${qUuid(sr.id)}))::int as parcel_twice,
      (select count(*) from public.late_sale_moves l join public.mex_parcels m on m.tracking_id = l.tracking
        where l.sync_run_id = ${qUuid(sr.id)} and m.order_id is distinct from l.relink_order_id)::int as register_elsewhere`);
  printTable([v]);
  if (v.holder_still_holds || v.lead_not_holding || v.parcel_twice || v.register_elsewhere) warn('a post-check is not 0 — investigate now.');
  console.log(yellow(`  Next: node scripts/verify-late-sale-new-order.mjs · node scripts/engine-fixture-mk.mjs · verify-insights-ties ·\n` +
    `        a Pure Profit refresh for the months that moved.\n  Undo: node scripts/repair-late-sale-relink.mjs --rollback ${args.run}\n`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
