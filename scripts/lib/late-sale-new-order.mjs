/**
 * late-sale-new-order — the pure half of scripts/repair-late-sale-new-order.mjs (owner, 03.10.2026 "ДА"). No I/O here
 * except the exported SQL strings the script runs.
 *
 * THE RULE (migration 20260947002000, one definition: late_sale_classify): a collabBox sales document or a MEX parcel
 * that arrived for an EXISTING order is that order's sale only when the lead was still open (case 1) or the order was
 * cancelled / trashed ≤ 10 days before it (case 2). Everything else — more than 10 days after the cancel / trash
 * ('dead_late'), after the order's own sale that never shipped ('stale'), or after the order had already shipped its
 * own earlier parcel ('second_sale') — is a NEW order on the booking day, credited to the document's author, its
 * department decided by the author's line team (a late 10111 is elyon_crm / collabbox_leads_late — never a lead), and
 * the OLD order goes back to exactly what it was before the document / parcel touched it.
 *
 * One UNIT = one old order + the parcel it holds = ONE sub-transaction: the LIVE writer re-applies the parcel's document
 * with `late_sale_force` (collabbox_apply_documents → collabbox_apply_one, 20260947002010), which releases the old order
 * (late_sale_release) and creates the new one in the same sub-block — it must answer 'created', else the unit rolls
 * back whole and is listed. Units without a sales document, orders in agent_payout_items and documents the writer would
 * not turn into an order (a twin, value 0, a skipped komitent, several orders naming the parcel …) are listed (manual).
 * The ledger is late_sale_moves (before / after of the old order, the document row, the new order); the undo is
 * late_sale_undo(sync run).
 */
import { q, qUuid, qJson, planLine, fmtMkd } from './repair-kit.mjs';

export const KEY = 'late-sale-new-order';
export const CASES = Object.freeze(['dead_late', 'stale', 'second_sale']);
export const DEPT_WORD = Object.freeze({
  altercpa: 'Тим Маџари In', elyon_crm: 'Тим Маџари Out', teleshop_out: 'Тим Центар Out',
  teleshop_other: 'Тим Центар In', social: 'Социјални мрежи', web: 'Веб-продавница', management: 'Менаџмент',
});
/** Read-only 03.10.2026 ~04:40 Skopje (late_sale_plan + the writer's dry path). Re-check with --expect. */
export const EXPECTED = Object.freeze({ units: 738, move: 685, manual: 53 });

/** Every case-3 unit (the one definition, read-only role). */
export const PLAN_SQL = `select p.*, to_char(p.doc_sale_at at time zone 'Europe/Skopje', 'YYYY-MM') as month_after,
       to_char(coalesce(p.sold_at, p.sale_at) at time zone 'Europe/Skopje', 'YYYY-MM') as month_before,
       o.customer_phone, o.created_at as order_created_at, o.sold_by_person_id as person_before,
       (select m.cod_mkd from public.mex_parcels m where m.tracking_id = p.prior_parcel) as prior_cod_mkd,
       (select m.status_id from public.mex_parcels m where m.tracking_id = p.prior_parcel) as prior_status_id,
       public.sales_person_team_at(p.author_person_id, p.doc_sale_at) as author_team,
       (select sp.display_name from public.sales_people sp where sp.id = p.author_person_id) as author_name,
       (select sp.display_name from public.sales_people sp where sp.id = o.sold_by_person_id) as seller_before_name
  from public.late_sale_plan() p join public.orders o on o.id = p.order_id
 order by p.display_id`;

/**
 * The live writer's verdict for every unit with a sales document, through its own dry path (p_dry = true writes
 * nothing). supabase_read_only_user may not execute the writer, so this runs on the privileged path inside a READ ONLY
 * transaction — PostgreSQL refuses any write (the collabbox-recredit pattern).
 */
export const PREDICT_SQL = `set transaction read only;
select p.order_id, r ->> 'outcome' as outcome, r ->> 'reason' as reason, r -> 'flags' as flags,
       r ->> 'author_person' as author_person, r ->> 'status' as new_status, r ->> 'sale_at' as sale_at
  from public.late_sale_plan() p
  join public.collabbox_documents d on d.doc_number = p.doc_number
  cross join lateral public.collabbox_apply_one(null, d.payload || '{"late_sale_force": true}'::jsonb, true) r
 where p.doc_number is not null`;

/** The status the old order goes back to (late_sale_release's rule, for the reports). */
export function restoredStatus(u) {
  if (u.kase === 'second_sale') {
    const s = Number(u.prior_status_id);
    return s === 2 ? 'paid' : s === 7 ? 'returned' : s === 8 ? 'confirmed' : 'shipped';
  }
  // an unproven courier status (no MEX parcel of its own) is cancelled by the system (20260947002030)
  if (u.kase === 'stale' && ['paid', 'delivered', 'shipped', 'returned'].includes(u.status_at)) return 'cancelled';
  return u.status_at;
}

/**
 * @returns {{ units, moves, manual, lines, counts, csv }} — units: the ones the live writer will turn into a new order.
 */
export function classifyLateSales({ plan, predictions, hold = new Set() }) {
  const pred = new Map(predictions.map((p) => [p.order_id, p]));
  const units = [], manual = [], lines = [], csv = [];
  const counts = { units: plan.length, move: 0, manual: 0, by_case: {}, manual_why: {} };
  for (const u of plan) {
    const p = pred.get(u.order_id);
    let why = '';
    if (hold.has(u.display_id)) why = 'held back with --hold';
    else if (u.in_payout) why = 'in agent_payout_items (payouts deferred by the owner)';
    else if (!u.doc_number) why = 'no collabBox sales document for the parcel (a parcel alone has no author — a human decides)';
    else if (!p) why = 'the writer gave no verdict';
    else if (p.outcome !== 'created') why = `the collabBox writer would answer: ${p.outcome}${p.reason ? ` / ${p.reason}` : ''}`;
    const action = why ? 'manual' : 'move';
    const line = planLine(u.order_id, `LS_${action}`, u.kase, u.tracking);
    lines.push(line);
    counts[action]++;
    counts.by_case[`${u.kase} ${u.doc_type_id || '-'} ${action}`] = (counts.by_case[`${u.kase} ${u.doc_type_id || '-'} ${action}`] || 0) + 1;
    if (why) {
      const k = why.replace(/ORD-\d+/g, 'ORD-…').slice(0, 100);
      counts.manual_why[k] = (counts.manual_why[k] || 0) + 1;
    }
    const row = {
      order: u.display_id, action, why, kase: u.kase, status_now: u.status_now, status_at_arrival: u.status_at,
      restored_to: restoredStatus(u), gap_days: u.gap_days, tracking: u.tracking, prior_parcel: u.prior_parcel || '',
      doc_type: u.doc_type_id || '', doc_outcome: u.doc_outcome || '', author: u.doc_author || '',
      value_mkd: u.value_mkd, month_before: u.month_before, month_after: u.month_after || '',
      dept_before: DEPT_WORD[u.dept_before] || u.dept_before, dept_after: DEPT_WORD[u.dept_after] || u.dept_after || '',
      new_status: p?.new_status || '', writer: p ? `${p.outcome}${p.reason ? `/${p.reason}` : ''}` : '',
      author_team: u.author_team || (u.doc_author ? '(no line team)' : ''), author_person: u.author_name || '',
      seller_before: u.seller_before_name || '',
    };
    csv.push(row);
    if (action === 'move') units.push({ ...u, line, prediction: p });
    else manual.push({ ...u, line, why });
  }
  return { units, manual, lines, counts, csv };
}

/**
 * Per Skopje month × department, what the cohort loses and gains (ден = the parcel's COD; MEX decides paid / with the
 * courier / returned, all counted): the old order's parcel leaves its department on its sale day, the new order brings
 * it to the author's department on the booking day; a second sale's old order counts its own earlier parcel again.
 */
export function moneyMoves(units) {
  const out = new Map();
  const add = (month, dept, k, n, mkd) => {
    const key = `${month}|${dept}`;
    const r = out.get(key) ?? { month, department: DEPT_WORD[dept] || dept, lose: 0, lose_mkd: 0, gain: 0, gain_mkd: 0 };
    r[k] += n; r[`${k}_mkd`] += mkd;
    out.set(key, r);
  };
  for (const u of units) {
    const cod = Number(u.value_mkd) || 0;
    add(u.month_before, u.dept_before, 'lose', 1, cod);
    add(u.month_after, u.dept_after, 'gain', 1, cod);
    if (u.kase === 'second_sale' && Number(u.prior_cod_mkd) > 0) add(u.month_before, u.dept_before, 'gain', 1, Number(u.prior_cod_mkd));
  }
  return [...out.values()].sort((a, b) => a.month.localeCompare(b.month) || a.department.localeCompare(b.department))
    .map((r) => ({ month: r.month, department: r.department, '−orders': r.lose, '−ден': fmtMkd(r.lose_mkd),
      '+orders': r.gain, '+ден': fmtMkd(r.gain_mkd), 'net ден': fmtMkd(r.gain_mkd - r.lose_mkd), _net: r.gain_mkd - r.lose_mkd }));
}

/** Тим Маџари In → anything, per month (the owner's question). */
export function madzariInMoves(units) {
  const out = {};
  for (const u of units.filter((x) => x.dept_before === 'altercpa')) {
    const k = `${u.month_before} → ${u.month_after} · ${DEPT_WORD[u.dept_after] || u.dept_after}`;
    out[k] ??= { n: 0, mkd: 0 };
    out[k].n++; out[k].mkd += Number(u.value_mkd) || 0;
  }
  return Object.entries(out).sort().map(([move, v]) => ({ 'Тим Маџари In (sale month → booking month · new department)': move, orders: v.n, 'ден': fmtMkd(v.mkd) }));
}

/** The rules that act on what the repair leaves behind (for the report). */
export function afterEffects(units, nowMs = Date.now()) {
  const day = 86_400_000;
  const restored = units.map((u) => ({ ...u, to: restoredStatus(u) }));
  return {
    restored_by_status: restored.reduce((m, u) => ({ ...m, [`${u.status_now} → ${u.to}`]: (m[`${u.status_now} → ${u.to}`] || 0) + 1 }), {}),
    // the list engine parks a customer in Current Cancels for a cancel < 14 days from the order's created_at
    current_cancels: restored.filter((u) => u.to === 'cancelled' && nowMs - new Date(u.order_created_at).getTime() < 14 * day).length,
    // an approval back to 'confirmed' with no parcel: the 10-day no-parcel rule (AlterCPA, sold ≥ 01.08) or the
    // 5-day collabBox rule (every other sale ≥ 01.08) cancels it at 21:10 / 21:20 unless an exemption holds
    no_parcel_rule: restored.filter((u) => u.to === 'confirmed' && u.kase === 'stale' && u.sale_source === 'altercpa'
      && new Date(u.sale_at).getTime() >= Date.parse('2026-08-01T00:00:00+02:00')).length,
    collab_entry_rule: restored.filter((u) => u.to === 'confirmed' && u.kase === 'stale' && u.sale_source !== 'altercpa'
      && new Date(u.sale_at).getTime() >= Date.parse('2026-08-01T00:00:00+02:00')).length,
    confirmed_before_august: restored.filter((u) => u.to === 'confirmed' && new Date(u.sale_at).getTime() < Date.parse('2026-08-01T00:00:00+02:00')).length,
  };
}

/**
 * ONE chunk = ONE API call = ONE transaction; inside, unit by unit in its own sub-transaction: re-check (the old order
 * still holds the parcel and is still that case) → the LIVE writer re-applies the document with late_sale_force → it
 * must answer 'created' with the parcel on the new order → data_repair_rows names the late_sale_moves row and the new
 * order. Anything else rolls the unit back whole and lists it.
 */
export function buildApplySql({ runId, syncRun, units }) {
  if (!units.length) throw new Error('no units');
  const values = units.map((u) => `(${[qUuid(u.order_id), q(u.tracking), q(u.kase), q(u.line)].join(', ')})`);
  return `
set local statement_timeout = '170s';
set local lock_timeout = '20s';
create temp table _ls (order_id uuid primary key, tracking text not null, kase text not null, line text not null) on commit drop;
insert into _ls values
${values.join(',\n')};
create temp table _ls_out (order_id uuid, tracking text, ok boolean, why text, new_order uuid, new_display text) on commit drop;
do $ls$
declare
  r record;
  d public.collabbox_documents%rowtype;
  res jsonb;
  e jsonb;
  nid uuid;
  mv bigint;
begin
  for r in select * from _ls order by order_id loop
    begin
      if not exists (select 1 from public.orders o where o.id = r.order_id and o.mex_tracking_id = r.tracking)
         or public.late_sale_case_of(r.order_id, r.tracking) is distinct from r.kase then
        insert into _ls_out values (r.order_id, r.tracking, false, 'moved since the dry run', null, null);
        continue;
      end if;
      select * into d from public.collabbox_documents where doc_number = r.tracking;
      if d.doc_number is null or d.payload is null then
        raise exception 'no document payload';
      end if;
      res := public.collabbox_apply_documents(${qUuid(syncRun)}, jsonb_build_array(d.payload || '{"late_sale_force": true}'::jsonb), false);
      e := res -> 'results' -> 0;
      if e is null or e ->> 'outcome' is distinct from 'created' or (e ->> 'order_id') is null then
        raise exception 'the collabBox writer answered % / %', coalesce(e ->> 'outcome', 'nothing'), coalesce(e ->> 'reason', '');
      end if;
      nid := (e ->> 'order_id')::uuid;
      if not exists (select 1 from public.mex_parcels where tracking_id = r.tracking and order_id = nid)
         or exists (select 1 from public.orders x where x.mex_tracking_id = r.tracking and x.id <> nid) then
        raise exception 'the parcel is not (only) on the new order';
      end if;
      select l.id into mv from public.late_sale_moves l where l.order_id = r.order_id and l.new_order_id = nid and l.undone_at is null;
      if mv is null then raise exception 'no late_sale_moves row'; end if;
      update public.late_sale_moves set scope = 'repair' where id = mv;
      insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
      values (${qUuid(runId)}, r.order_id, 'LS_split', jsonb_build_object('move', mv),
              jsonb_build_object('new_order', nid, 'new_display', (select display_id from public.orders where id = nid)),
              jsonb_build_object('key', ${q(KEY)}, 'line', r.line, 'tracking', r.tracking, 'kase', r.kase, 'move', mv,
                                 'sync_run', ${q(syncRun)}, 'writer', e));
      insert into _ls_out values (r.order_id, r.tracking, true, null, nid, (select display_id from public.orders where id = nid));
    exception when others then
      insert into _ls_out values (r.order_id, r.tracking, false, left(sqlerrm, 300), null, null);
    end;
  end loop;
end $ls$;
select (select count(*) from _ls)::int as planned, (select count(*) from _ls_out where ok)::int as applied,
       (select coalesce(jsonb_agg(jsonb_build_object('order', order_id, 'new', new_display)), '[]'::jsonb) from _ls_out where ok) as made,
       (select coalesce(jsonb_agg(jsonb_build_object('order', order_id, 'tracking', tracking, 'why', why)), '[]'::jsonb) from _ls_out where not ok) as skipped;`;
}

/** The forward switch (the writer splits late holders by itself from then on). */
export const switchSql = (mode) => `update public.app_settings
   set value = value || ${qJson({ mode })}, updated_at = now()
 where key = 'late_sale_new_order' returning value`;

/** The owner's view (03.10.2026): the new orders per author's TEAM and per PERSON (credited = the document's author). */
export function teamPersonSplit(units) {
  const team = {}, person = {};
  for (const u of units) {
    const t = `${u.author_team || '(no line team)'} → ${DEPT_WORD[u.dept_after] || u.dept_after}`;
    team[t] ??= { n: 0, mkd: 0 }; team[t].n++; team[t].mkd += Number(u.value_mkd) || 0;
    const p = `${u.author_name || u.doc_author || '(no author)'} · ${u.author_team || '-'}`;
    person[p] ??= { n: 0, mkd: 0 }; person[p].n++; person[p].mkd += Number(u.value_mkd) || 0;
  }
  const rows = (o, label) => Object.entries(o).sort((a, b) => b[1].mkd - a[1].mkd).map(([k, v]) => ({ [label]: k, orders: v.n, 'ден': fmtMkd(v.mkd) }));
  return { team: rows(team, "author's team → department"), person: rows(person, 'author (credited) · team') };
}

/** The new orders' status from MEX (2 paid · 7 returned · 8 confirmed (за пакување) · 1/4/10/3/9/13 shipped) × team × month. */
export function statusSplit(units) {
  const out = {};
  for (const u of units) {
    const k = `${u.month_after}|${u.author_team || '(no line team)'}`;
    out[k] ??= { month: u.month_after, team: u.author_team || '(no line team)', paid: 0, returned: 0, shipped: 0, confirmed: 0, cancelled: 0, mkd: 0 };
    const st = u.prediction?.new_status || 'shipped';
    out[k][st in out[k] ? st : 'shipped']++;
    out[k].mkd += Number(u.value_mkd) || 0;
  }
  return Object.values(out).sort((a, b) => a.month.localeCompare(b.month) || a.team.localeCompare(b.team))
    .map((r) => ({ ...r, mkd: fmtMkd(r.mkd) }));
}
