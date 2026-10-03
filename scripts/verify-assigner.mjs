/**
 * verify-assigner — READ-ONLY proof that the redesigned Assigner's SQL (plan
 * "Assigner redesign", Part A, migrations 20260942001950–1962) says what it
 * claims, against an independent recount of the live tables.
 *
 *   node scripts/verify-assigner.mjs            (text report)
 *   node scripts/verify-assigner.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   A1  the board, per agent: pendings (pending | take | call_again on lead
 *       sources) with its pending / take parts, call-agains (lead orders +
 *       member callbacks), list open / parked / assigned = a recount straight
 *       from orders and prediction_segment_members — in the SAME snapshot
 *   A2  assigned_pending_counts() = the board's pendings for every agent on it
 *       (a holder that is NOT on the board — an inactive profile — is a WARN)
 *   A3  the board's roster = every active staff profile; the totals (unassigned
 *       lead pendings, unassigned call-agains orders / members / oldest, online,
 *       in call, Σ worked today) = a recount
 *   L1  every list: Σ by_department.total = total = its members; distributable /
 *       assigned / done / open = a recount; the list set = active and non-empty
 *   L2  a department filter: each list's total / distributable = Σ of the
 *       selected departments' cells, and the totals = Σ lists
 *   D1  dry-run distributions (nothing written, no locks — p_dry_run := true):
 *       pool = an independent count, selected = min(ask, pool), the round-robin
 *       split (100 over 3 = 34/33/33, per agent × 3, one agent = all), the
 *       newest / oldest first item, the department filter, pendings, and the
 *       call-agains pools by source = the board's totals
 *   C1  call-agains page: true totals = the recount; unassigned = the board
 *   B1  buyer departments: the share of list members with a customer_departments
 *       row, phones in orders without a row, and the last refresh (WARN when old)
 *   T   timings (server round trips)
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) —
 * pinned to Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria,
 * every statement a single SELECT / WITH sent with read_only: true. A dry-run
 * distribution takes no row lock and writes nothing, so it runs read-only.
 */
import { runSql } from './verify-insights-ties.mjs';

const LEAD = `('altercpa', 'inbound_lead', 'opencart', 'opencart_abandoned')`;
const DEPTS = ['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web', 'unknown'];
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const uuidArr = (ids) => `ARRAY[${ids.map((i) => `${lit(i)}::uuid`).join(', ')}]::uuid[]`;
const textArr = (xs) => (xs == null ? 'NULL::text[]' : `ARRAY[${xs.map(lit).join(', ')}]::text[]`);
/** The server's deal: item k → agent (k mod n); the first agents take the remainder. */
export const expectedSplit = (selected, agents) =>
  Array.from({ length: agents }, (_, i) => Math.floor(selected / agents) + (i < selected % agents ? 1 : 0));

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}

// ── A: the board ──────────────────────────────────────────────────────────────

async function verifyBoard() {
  const [row] = await timed('board + recount', `
    WITH b AS MATERIALIZED (SELECT public.assigner_board() AS j),
    a AS (SELECT x FROM b, jsonb_array_elements(b.j->'agents') x),
    per AS (
      SELECT x->>'user_id' AS uid, x->>'full_name' AS name,
             jsonb_build_object(
               'pendings', (x->>'pendings')::int, 'pendings_pending', (x->>'pendings_pending')::int,
               'pendings_take', (x->>'pendings_take')::int, 'call_agains', (x->>'call_agains')::int,
               'call_agains_orders', (x->>'call_agains_orders')::int, 'call_agains_members', (x->>'call_agains_members')::int,
               'list_open', (x->>'list_open')::int, 'list_parked', (x->>'list_parked')::int,
               'list_assigned', (x->>'list_assigned')::int) AS got,
             (SELECT jsonb_build_object(
                'pendings', o.p, 'pendings_pending', o.pp, 'pendings_take', o.pt, 'call_agains', o.ca + m.ca,
                'call_agains_orders', o.ca, 'call_agains_members', m.ca,
                'list_open', m.op, 'list_parked', m.pk, 'list_assigned', m.asg)
                FROM (SELECT count(*)::int p,
                             count(*) FILTER (WHERE status = 'pending')::int pp,
                             count(*) FILTER (WHERE status = 'take')::int pt,
                             count(*) FILTER (WHERE status = 'call_again')::int ca
                        FROM public.orders
                       WHERE assigned_agent_id = (x->>'user_id')::uuid
                         AND status IN ('pending', 'take', 'call_again') AND source_type IN ${LEAD}) o,
                     (SELECT count(*) FILTER (WHERE NOT is_completed AND call_again_since IS NOT NULL)::int ca,
                             count(*) FILTER (WHERE NOT is_completed)::int op,
                             count(*) FILTER (WHERE NOT is_completed AND in_call_again_until > now())::int pk,
                             count(*)::int asg
                        FROM public.prediction_segment_members
                       WHERE assigned_agent_id = (x->>'user_id')::uuid) m) AS want
      FROM a)
    SELECT
      (SELECT j->'totals' FROM b) AS totals,
      (SELECT jsonb_array_length(j->'agents') FROM b) AS agents,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('uid', uid, 'name', name, 'got', got, 'want', want)), '[]'::jsonb) FROM per) AS per,
      (SELECT coalesce(jsonb_agg(jsonb_build_object('agent_id', c.agent_id, 'pendings', c.pendings,
                 'board', (SELECT (x->>'pendings')::int FROM a WHERE x->>'user_id' = c.agent_id::text))), '[]'::jsonb)
         FROM public.assigned_pending_counts() c) AS apc,
      (SELECT count(*) FROM public.profiles p
        WHERE p.is_active AND p.user_id IS NOT NULL
          AND NOT (EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id)
                   AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role::text <> 'affiliate'))) AS roster,
      (SELECT count(*) FROM a WHERE (x->>'online')::boolean) AS online,
      (SELECT count(*) FROM a WHERE (x->>'in_call')::boolean) AS in_call,
      (SELECT coalesce(sum((x->>'worked_today')::int), 0) FROM a) AS worked_sum,
      (SELECT count(*) FROM public.orders WHERE assigned_agent_id IS NULL AND status = 'pending' AND source_type IN ${LEAD}) AS pu,
      (SELECT count(*) FROM public.orders WHERE assigned_agent_id IS NULL AND status = 'call_again' AND source_type IN ${LEAD}) AS cao,
      (SELECT count(*) FROM public.prediction_segment_members WHERE assigned_agent_id IS NULL AND call_again_since IS NOT NULL AND NOT is_completed) AS cam,
      least((SELECT min(call_again_since) FROM public.orders WHERE assigned_agent_id IS NULL AND status = 'call_again' AND source_type IN ${LEAD}),
            (SELECT min(call_again_since) FROM public.prediction_segment_members WHERE assigned_agent_id IS NULL AND call_again_since IS NOT NULL AND NOT is_completed)) AS oldest
  `);
  const per = parse(row.per);
  const a1 = check('A1', 'board per agent = the recount (same snapshot)');
  let bad = 0;
  for (const p of per) {
    const got = parse(p.got);
    const want = parse(p.want);
    if (JSON.stringify(got) !== JSON.stringify(want)) { bad++; a1.tie(p.name || p.uid, want, got); }
  }
  a1.tie('agents with a mismatch', 0, bad);
  a1.info('agents on the board', per.length);

  const a2 = check('A2', 'assigned_pending_counts() = the board pendings');
  for (const r of parse(row.apc)) {
    if (r.board == null) a2.warn(`holder not on the board ${r.agent_id}`, `${r.pendings} lead pendings on an inactive / non-staff profile`);
    else a2.tie(`agent ${r.agent_id}`, r.pendings, r.board);
  }

  const t = parse(row.totals);
  const a3 = check('A3', 'roster and totals = the recount');
  a3.tie('agents = active staff profiles', n(row.roster), n(t.agents));
  a3.tie('agents[] length', n(t.agents), n(row.agents));
  a3.tie('online', n(row.online), n(t.online));
  a3.tie('in call', n(row.in_call), n(t.in_call));
  a3.tie('worked today = Σ agents', n(row.worked_sum), n(t.worked_today));
  a3.tie('pendings unassigned', n(row.pu), n(t.pendings_unassigned));
  a3.tie('call-agains unassigned orders', n(row.cao), n(t.call_agains_unassigned_orders));
  a3.tie('call-agains unassigned members', n(row.cam), n(t.call_agains_unassigned_members));
  a3.tie('call-agains unassigned = orders + members', n(row.cao) + n(row.cam), n(t.call_agains_unassigned));
  a3.tie('oldest unassigned call-again', row.oldest ? Date.parse(row.oldest) : null, t.oldest_call_again_since ? Date.parse(t.oldest_call_again_since) : null);
}

// ── L: the lists ──────────────────────────────────────────────────────────────

async function verifyLists() {
  const [row] = await timed('lists + recount', `
    WITH l AS MATERIALIZED (SELECT public.assigner_lists(NULL) AS j),
    e AS (SELECT x FROM l, jsonb_array_elements(l.j->'lists') x)
    SELECT
      (SELECT coalesce(jsonb_agg(jsonb_build_object(
         'name', x->>'name', 'total', (x->>'total')::int,
         'sum_dept', (SELECT sum((v->>'total')::int) FROM jsonb_each(x->'by_department') d(k, v)),
         'keys', (SELECT count(*) FROM jsonb_object_keys(x->'by_department')),
         'got', jsonb_build_array((x->>'distributable')::int, (x->>'assigned')::int, (x->>'done')::int, (x->>'open')::int),
         'want', (SELECT jsonb_build_array(
                    count(*) FILTER (WHERE NOT m.is_completed AND m.assigned_agent_id IS NULL),
                    count(*) FILTER (WHERE m.assigned_agent_id IS NOT NULL),
                    count(*) FILTER (WHERE m.is_completed),
                    count(*) FILTER (WHERE NOT m.is_completed))
                    FROM public.prediction_segment_members m WHERE m.list_id = (x->>'id')::uuid),
         'members', (SELECT count(*) FROM public.prediction_segment_members m WHERE m.list_id = (x->>'id')::uuid))), '[]'::jsonb) FROM e) AS lists,
      (SELECT count(*) FROM public.prediction_segment_lists pl
        WHERE pl.is_active AND EXISTS (SELECT 1 FROM public.prediction_segment_members m WHERE m.list_id = pl.id)) AS want_lists,
      (SELECT j->'totals' FROM l) AS totals
  `);
  const lists = parse(row.lists);
  const l1 = check('L1', 'every list: Σ departments = total = members; counts = the recount');
  l1.tie('lists = active non-empty lists', n(row.want_lists), lists.length);
  let bad = 0;
  for (const x of lists) {
    const ok = x.sum_dept === x.total && x.total === x.members && x.keys === DEPTS.length
      && JSON.stringify(x.got) === JSON.stringify(x.want);
    if (!ok) { bad++; l1.tie(x.name, { total: x.members, sum: x.members, keys: 7, counts: x.want }, { total: x.total, sum: x.sum_dept, keys: x.keys, counts: x.got }); }
  }
  l1.tie('lists with a mismatch', 0, bad);
  const tot = parse(row.totals);
  l1.tie('totals.total = Σ lists', lists.reduce((s, x) => s + x.total, 0), n(tot.total));
  l1.info('members in lists', n(tot.total));

  const sel = ['teleshop_out', 'unknown'];
  const [f] = await timed('lists filtered', `
    WITH l AS MATERIALIZED (SELECT public.assigner_lists(${textArr(sel)}) AS j),
    e AS (SELECT x FROM l, jsonb_array_elements(l.j->'lists') x)
    SELECT (SELECT count(*) FROM e
             WHERE (x->>'total')::int <> (SELECT sum((x->'by_department'->k->>'total')::int) FROM unnest(${textArr(sel)}) k)
                OR (x->>'distributable')::int <> (SELECT sum((x->'by_department'->k->>'distributable')::int) FROM unnest(${textArr(sel)}) k)) AS bad,
           (SELECT sum((x->>'total')::int) FROM e) AS sum_total,
           (SELECT (j->'totals'->>'total')::int FROM l) AS totals_total,
           (SELECT j->'departments' FROM l) AS depts
  `);
  const l2 = check('L2', `a department filter (${sel.join(' + ')}) = Σ its cells`);
  l2.tie('lists whose total / distributable ≠ Σ selected cells', 0, n(f.bad));
  l2.tie('totals.total = Σ lists', n(f.sum_total), n(f.totals_total));
  l2.tie('departments echoed', sel, parse(f.depts));
}

// ── D: dry-run distributions ──────────────────────────────────────────────────

async function verifyDistribute() {
  const [ctx] = await runSql(`
    SELECT
      (SELECT coalesce(jsonb_agg(z.user_id ORDER BY z.full_name), '[]'::jsonb) FROM (
         SELECT p.user_id, p.full_name FROM public.profiles p
          WHERE p.is_active
            AND EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role = 'pending_agent')
            AND NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = p.user_id AND r.role IN ('admin', 'manager'))
          ORDER BY p.full_name LIMIT 3) z) AS agents,
      (SELECT jsonb_build_object('id', l.id, 'name', l.name) FROM public.prediction_segment_lists l
        WHERE l.is_active AND (NOT l.is_static OR l.name IN ('FULL MONAD LIST', 'Trash List'))
        ORDER BY (SELECT count(*) FROM public.prediction_segment_members m
                   WHERE m.list_id = l.id AND NOT m.is_completed AND m.assigned_agent_id IS NULL) DESC
        LIMIT 1) AS list
  `);
  const agents = parse(ctx.agents);
  const list = parse(ctx.list);
  const d1 = check('D1', `dry-run distributions (list "${list?.name}", ${agents.length} agents)`);
  if (agents.length < 3 || !list) { d1.warn('setup', 'need 3 pending agents and an assignable list'); return; }
  const A = uuidArr(agents);
  const A1 = uuidArr([agents[0]]);
  const L = `${lit(list.id)}::uuid`;
  const listPool = `(SELECT count(*) FROM public.prediction_segment_members m WHERE m.list_id = ${L} AND NOT m.is_completed AND m.assigned_agent_id IS NULL)`;
  const dist = (kind, listId, depts, order, count, split, agentsSql, source = 'all') =>
    `public.assigner_distribute(${lit(kind)}, ${listId}, ${textArr(depts)}, ${lit(order)}, ${count == null ? 'NULL::int' : count}, ${lit(split)}, ${agentsSql}, false, true, ${lit(source)})`;

  const [r] = await timed('dry runs', `
    SELECT
      ${dist('list', L, null, 'newest', 100, 'total', A)} AS c1,
      ${listPool} AS c1_pool,
      (SELECT 'member:' || m.list_id || ':' || m.customer_phone FROM public.prediction_segment_members m
        WHERE m.list_id = ${L} AND NOT m.is_completed AND m.assigned_agent_id IS NULL
        ORDER BY m.trigger_event_at DESC NULLS LAST, m.list_id::text || '|' || m.customer_phone LIMIT 1) AS c1_first,
      ${dist('list', L, null, 'oldest', 50, 'per_agent', A)} AS c2,
      (SELECT 'member:' || m.list_id || ':' || m.customer_phone FROM public.prediction_segment_members m
        WHERE m.list_id = ${L} AND NOT m.is_completed AND m.assigned_agent_id IS NULL
        ORDER BY m.trigger_event_at ASC NULLS LAST, m.list_id::text || '|' || m.customer_phone LIMIT 1) AS c2_first,
      ${dist('list', L, null, 'random', null, 'total', A1)} AS c3,
      ${dist('list', L, ['teleshop_out', 'unknown'], 'newest', null, 'total', A)} AS c4,
      (SELECT count(*) FROM public.prediction_segment_members m
         LEFT JOIN public.customer_departments cd ON cd.customer_phone = m.customer_phone
        WHERE m.list_id = ${L} AND NOT m.is_completed AND m.assigned_agent_id IS NULL
          AND public.assigner_dept_key(cd.department) IN ('teleshop_out', 'unknown')) AS c4_pool,
      ${dist('pendings', 'NULL::uuid', null, 'oldest', null, 'total', A)} AS c5,
      (SELECT count(*) FROM public.orders WHERE status = 'pending' AND source_type IN ${LEAD} AND assigned_agent_id IS NULL) AS c5_pool,
      ${dist('call_agains', 'NULL::uuid', null, 'oldest', 10, 'total', uuidArr(agents.slice(0, 2)), 'all')} AS c6,
      ${dist('call_agains', 'NULL::uuid', null, 'newest', null, 'total', A, 'order')} AS c6o,
      ${dist('call_agains', 'NULL::uuid', null, 'newest', null, 'total', A, 'prediction')} AS c6m,
      public.assigner_board()->'totals' AS bt
  `);
  // the board read in the SAME statement: agents keep working between statements
  const boardTotals = parse(r.bt);
  const c1 = parse(r.c1);
  const pool = n(r.c1_pool);
  d1.tie('list pool = open unassigned members', pool, n(c1.pool));
  d1.tie('100 over 3: selected', Math.min(100, pool), n(c1.selected));
  d1.tie('100 over 3: split', expectedSplit(Math.min(100, pool), 3), c1.per_agent.map((p) => n(p.count)));
  d1.tie('newest: first item', r.c1_first, c1.ids?.[0] ?? null);
  d1.tie('dry run wrote nothing', 0, n(c1.assigned));
  const c2 = parse(r.c2);
  d1.tie('50 per agent × 3: split', expectedSplit(Math.min(150, pool), 3), c2.per_agent.map((p) => n(p.count)));
  d1.tie('oldest: first item', r.c2_first, c2.ids?.[0] ?? null);
  const c3 = parse(r.c3);
  d1.tie('all to one agent (random)', [pool], c3.per_agent.map((p) => n(p.count)));
  const c4 = parse(r.c4);
  d1.tie('department filter pool (teleshop_out + unknown)', n(r.c4_pool), n(c4.pool));
  d1.tie('department filter split', expectedSplit(n(r.c4_pool), 3), c4.per_agent.map((p) => n(p.count)));
  const c5 = parse(r.c5);
  d1.tie('pendings pool = unassigned lead pendings', n(r.c5_pool), n(c5.pool));
  d1.tie('pendings pool = board total', n(boardTotals.pendings_unassigned), n(c5.pool));
  d1.tie('pendings split', expectedSplit(n(r.c5_pool), 3), c5.per_agent.map((p) => n(p.count)));
  const c6 = parse(r.c6);
  d1.tie('call-agains pool = board total', n(boardTotals.call_agains_unassigned), n(c6.pool));
  d1.tie('call-agains 10 over 2', expectedSplit(Math.min(10, n(c6.pool)), 2), c6.per_agent.map((p) => n(p.count)));
  d1.tie('call-agains orders pool = board', n(boardTotals.call_agains_unassigned_orders), n(parse(r.c6o).pool));
  d1.tie('call-agains members pool = board', n(boardTotals.call_agains_unassigned_members), n(parse(r.c6m).pool));
}

// ── C: the call-agains page ───────────────────────────────────────────────────

async function verifyCallAgains() {
  const [r] = await timed('call-agains page', `
    SELECT public.assigner_call_agains(NULL, 'all', NULL, 'oldest', 50, 0) AS a,
           public.assigner_call_agains('unassigned', 'all', NULL, 'newest', 50, 0) AS u,
           (SELECT count(*) FROM public.orders WHERE status = 'call_again' AND source_type IN ${LEAD}) AS o,
           (SELECT count(*) FROM public.prediction_segment_members WHERE call_again_since IS NOT NULL AND NOT is_completed) AS m,
           public.assigner_board()->'totals' AS bt
  `);
  const boardTotals = parse(r.bt);
  const a = parse(r.a);
  const c1 = check('C1', 'GET /call-agains: true totals');
  c1.tie('orders', n(r.o), n(a.total_orders));
  c1.tie('members', n(r.m), n(a.total_members));
  c1.tie('total', n(r.o) + n(r.m), n(a.total));
  c1.tie('unassigned = board', n(boardTotals.call_agains_unassigned), n(parse(r.u).total));
}

// ── B: buyer departments ──────────────────────────────────────────────────────

async function verifyDepartments() {
  const [r] = await timed('departments coverage', `
    SELECT (SELECT count(*) FROM public.prediction_segment_members) AS members,
           (SELECT count(*) FROM public.prediction_segment_members m
             WHERE EXISTS (SELECT 1 FROM public.customer_departments cd WHERE cd.customer_phone = m.customer_phone)) AS covered,
           (SELECT count(DISTINCT o.customer_phone) FROM public.orders o
             WHERE o.customer_phone <> ''
               AND NOT EXISTS (SELECT 1 FROM public.customer_departments cd WHERE cd.customer_phone = o.customer_phone)) AS phones_missing,
           (SELECT count(*) FROM public.customer_departments) AS rows,
           (SELECT jsonb_object_agg(department, c) FROM (SELECT department, count(*) c FROM public.customer_departments GROUP BY 1) z) AS by_dept,
           (SELECT to_jsonb(s) FROM public.customer_departments_state s) AS state
  `);
  const b1 = check('B1', 'buyer departments (customer_departments)');
  const members = n(r.members);
  const covered = n(r.covered);
  const pct = members ? Math.round((covered / members) * 10000) / 100 : 0;
  b1.info('list members with a department row', `${covered} / ${members} (${pct}%)`);
  b1.info('rows by department', parse(r.by_dept));
  const st = parse(r.state) || {};
  b1.info('last refresh', `${st.last_mode ?? 'never'} at ${st.last_run_at ?? '—'} (${st.last_rows ?? 0} rows changed, ${st.last_ms ?? 0} ms)`);
  if (!st.watermark) b1.warn('full fill', 'never ran — every buyer reads as unknown until refresh_customer_departments(true)');
  if (pct < 99) b1.warn('coverage', `${pct}% < 99%`);
  if (n(r.phones_missing) > 50) b1.warn('phones in orders without a row', n(r.phones_missing));
  else b1.info('phones in orders without a row', n(r.phones_missing));
  const ageMin = st.last_run_at ? (Date.now() - Date.parse(st.last_run_at)) / 60000 : Infinity;
  if (st.watermark && ageMin > 30) b1.warn('refresh age', `${Math.round(ageMin)} min since the last run (cron every 10 min)`);
}

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regprocedure('public.assigner_board()') IS NOT NULL AS board,
           to_regprocedure('public.assigner_lists(text[])') IS NOT NULL AS lists,
           to_regprocedure('public.assigner_distribute(text,uuid,text[],text,integer,text,uuid[],boolean,boolean,text,text)') IS NOT NULL AS distribute,
           to_regprocedure('public.assigner_call_agains(text,text,text[],text,integer,integer)') IS NOT NULL AS call_agains,
           to_regclass('public.customer_departments') IS NOT NULL AS cache
  `);
  const missing = Object.entries(have).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error(`verify-assigner: not applied yet (${missing.join(', ')}) — apply 20260942001950 … 1962 first`);
    process.exit(2);
  }
  await verifyBoard();
  await verifyLists();
  await verifyDistribute();
  await verifyCallAgains();
  await verifyDepartments();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-assigner', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log('verify-assigner · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-assigner error: ${e?.message ?? e}`); process.exit(2); });
