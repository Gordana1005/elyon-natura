/**
 * verify-teams — READ-ONLY proof that "teams = business lines" (owner ruling 30.09.2026, plan
 * "Фаза 3", migrations 20260943000900 / 20260943000950) holds on the live data.
 *
 *   node scripts/verify-teams.mjs            (text report)
 *   node scripts/verify-teams.mjs --json
 *   node scripts/verify-teams.mjs --day 2026-09-29     (the board day of T2; default yesterday, Skopje)
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   T1  every ACTIVE sales person has exactly ONE primary membership today, on a business line
 *       (teleshop / affiliate) WITH its lane, or on management WITHOUT one — never a legacy key
 *       (an inactive person still on a legacy key = a WARN: their history is not relabelled)
 *   T2  the legacy aliases resolve: sales_team_filter_matches() on a grid of (team, lane) pairs,
 *       and leaderboard_day_v2(day, NULL, f) for f = altercpa_leads / crm_prediction / every
 *       'team:lane' on the board = exactly the rows of the unfiltered board that f names, with
 *       the same numbers
 *   T3  the SELLER'S TEAM decides a department in ONE place (owner 02.10.2026, 20260947000400):
 *       order_dept_by_team (via sales_person_line_at) — a lead (sale_source altercpa) never; the
 *       pure mappings cohort_order_source, order_dept_override, classify_sale_source,
 *       collabbox_department, cohort_parcel_source, cohort_parcel_split mention no team table;
 *       no AlterCPA lead carries a stored department; every real sale of the last 60 days by a
 *       line member sits in its seller's team department
 *   T4  the teams table: teleshop / affiliate = line, management = management, the old keys =
 *       legacy; no lane on a non-line membership; 'social' only in teleshop
 *   T5  sales_team_line_proposal(60)'s window counts = a recount order by order with the
 *       4-argument cohort_order_source (the proposal folds orders by the tracking series first)
 *   T   timings
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) — pinned to
 * Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single
 * SELECT / WITH sent with read_only: true.
 */
import { runSql } from './verify-insights-ties.mjs';

const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const YMD = /^\d{4}-\d{2}-\d{2}$/;

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

// ── T1: one line per active seller ─────────────────────────────────────────────
async function verifyMemberships() {
  const c = check('T1', 'every active seller: one primary membership today — a line with its lane, or management');
  const rows = await timed('memberships', `
    WITH d AS (SELECT (now() AT TIME ZONE 'Europe/Skopje')::date AS today),
    cur AS (
      SELECT sp.id, sp.display_name, sp.is_active,
             count(m.*) FILTER (WHERE m.is_primary AND m.valid_from <= d.today AND coalesce(m.valid_to, 'infinity'::date) >= d.today) AS n_primary,
             (array_agg(m.team_key ORDER BY m.valid_from DESC) FILTER (WHERE m.is_primary AND m.valid_from <= d.today AND coalesce(m.valid_to, 'infinity'::date) >= d.today))[1] AS team_key,
             (array_agg(m.lane ORDER BY m.valid_from DESC) FILTER (WHERE m.is_primary AND m.valid_from <= d.today AND coalesce(m.valid_to, 'infinity'::date) >= d.today))[1] AS lane,
             bool_or(st.kind = 'legacy') AS any_legacy
      FROM public.sales_people sp
      CROSS JOIN d
      LEFT JOIN public.sales_team_members m ON m.person_id = sp.id
      LEFT JOIN public.sales_teams st ON st.key = m.team_key
      GROUP BY sp.id, sp.display_name, sp.is_active
    )
    SELECT cur.id, cur.display_name, cur.is_active, cur.n_primary, cur.team_key, cur.lane, st.kind, cur.any_legacy
    FROM cur LEFT JOIN public.sales_teams st ON st.key = cur.team_key
    ORDER BY cur.display_name`);
  const active = rows.filter((r) => r.is_active);
  const bad = active.filter((r) => n(r.n_primary) !== 1
    || !(r.kind === 'line' || r.kind === 'management')
    || (r.kind === 'line' && !r.lane)
    || (r.kind === 'management' && r.lane));
  c.info('active people', active.length);
  const by = {};
  for (const r of active) { const k = `${r.team_key ?? '—'}:${r.lane ?? '-'}`; by[k] = (by[k] ?? 0) + 1; }
  c.info('active by team:lane', by);
  c.tie('active people not on exactly one line / management membership', [],
    bad.map((r) => `${r.display_name} (${n(r.n_primary)}× ${r.team_key ?? 'no team'}${r.lane ? `:${r.lane}` : ''})`));
  const oldHist = rows.filter((r) => !r.is_active && r.any_legacy).map((r) => r.display_name);
  if (oldHist.length) c.warn(`inactive people still on a legacy key (history not relabelled): ${oldHist.length}`, oldHist.slice(0, 20).join(', '));
}

// ── T2: the legacy aliases and team:lane on the board ──────────────────────────
function expectedMatch(filter, team, lane) {
  if (filter === 'none') return team == null;
  if (filter === 'altercpa_leads') return team === 'altercpa_leads' || (team === 'affiliate' && lane === 'in');
  if (filter === 'crm_prediction') return team === 'crm_prediction' || lane === 'out';
  if (filter.includes(':')) { const [t, l] = filter.split(':'); return team === t && lane === l; }
  return team === filter;
}

async function verifyAliases(day) {
  const c = check('T2', `the legacy aliases and team:lane resolve (sales_team_filter_matches · leaderboard_day_v2 ${day})`);
  const filters = ['none', 'altercpa_leads', 'crm_prediction', 'teleshop', 'teleshop:in', 'teleshop:out', 'teleshop:social',
    'affiliate', 'affiliate:in', 'affiliate:out', 'management'];
  const pairs = [[null, null], ['altercpa_leads', null], ['crm_prediction', null], ['teleshop', 'in'], ['teleshop', 'out'],
    ['teleshop', 'social'], ['affiliate', 'in'], ['affiliate', 'out'], ['management', null]];
  const grid = await timed('filter grid', `
    SELECT f.f, p.t, p.l, public.sales_team_filter_matches(f.f, p.t, p.l) AS m
    FROM (VALUES ${filters.map((f) => `(${lit(f)})`).join(', ')}) f(f)
    CROSS JOIN (VALUES ${pairs.map(([t, l]) => `(${lit(t)}::text, ${lit(l)}::text)`).join(', ')}) p(t, l)`);
  const wrong = grid.filter((g) => g.m !== expectedMatch(g.f, g.t, g.l)).map((g) => `${g.f} ⟂ ${g.t ?? '∅'}:${g.l ?? '-'} → ${g.m}`);
  c.tie('sales_team_filter_matches grid = the documented rule', [], wrong);

  const board = async (team) => {
    const [r] = await timed(`board ${team ?? 'all'}`,
      `SELECT public.leaderboard_day_v2(${lit(day)}::date, NULL::text, ${lit(team)}::text) AS doc`);
    return parse(r.doc);
  };
  const all = await board(null);
  const rows = all.rows ?? [];
  const keys = new Set(['altercpa_leads', 'crm_prediction', 'none']);
  for (const tm of all.teams ?? []) { keys.add(tm.key); for (const l of tm.lanes ?? []) keys.add(l.key); }
  c.info('filters checked', [...keys].join(', '));
  for (const f of keys) {
    const got = await board(f);
    const want = rows.filter((r) => expectedMatch(f, r.team_key ?? null, r.team_lane ?? null));
    c.tie(`${f}: its rows`, want.map((r) => r.person_id).sort().join(','), (got.rows ?? []).map((r) => r.person_id).sort().join(','));
    let diff = 0;
    for (const r of got.rows ?? []) {
      const u = rows.find((x) => x.person_id === r.person_id) ?? {};
      if (n(r.total_count) !== n(u.total_count) || Math.round(n(r.total_value_mkd)) !== Math.round(n(u.total_value_mkd)) || n(r.worked) !== n(u.worked)) diff++;
    }
    c.tie(`${f}: numbers unchanged`, 0, diff);
  }
  // the teams list: people per team = its rows, lanes per team = its rows with that lane
  for (const tm of all.teams ?? []) {
    const mine = rows.filter((r) => (r.team_key ?? 'none') === tm.key);
    c.tie(`teams[${tm.key}].people`, mine.length, n(tm.people));
    for (const l of tm.lanes ?? []) c.tie(`teams[${l.key}].people`, mine.filter((r) => r.team_lane === l.lane).length, n(l.people));
  }
}

// ── T3: the seller's team decides, in one place (owner 02.10.2026) ────────────
async function verifyDepartmentsIgnoreTeams() {
  const c = check('T3', "the seller's team decides a department in one place (a lead never)");
  const rows = await timed('department functions', `
    SELECT p.oid::regprocedure::text AS sig,
           p.prosrc ~* 'sales_team_members' AS members,
           p.prosrc ~* 'sales_teams' AS teams,
           p.prosrc ~* 'sales_person_in_team' AS in_team
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
    WHERE ns.nspname = 'public'
      AND p.proname IN ('cohort_order_source', 'order_dept_override', 'classify_sale_source', 'collabbox_department',
                        'cohort_parcel_source', 'cohort_parcel_split')
    ORDER BY 1`);
  c.info('pure mappings', rows.map((r) => r.sig).join(' · '));
  for (const need of ['cohort_order_source', 'order_dept_override', 'classify_sale_source', 'collabbox_department']) {
    if (!rows.some((r) => r.sig.startsWith(`${need}(`))) c.warn(`${need}`, 'not found');
  }
  c.tie('pure mappings that mention sales_team_members / sales_teams / sales_person_in_team', [],
    rows.filter((r) => r.members || r.teams || r.in_team).map((r) => r.sig));
  const [d] = await timed('team decision', `
    SELECT (SELECT strpos(prosrc, 'p_sale_source = ''altercpa''') > 0 FROM pg_proc WHERE proname = 'order_dept_by_team') AS lead_first,
           (SELECT count(*) FROM public.orders WHERE sale_source = 'altercpa' AND dept_override IS NOT NULL)::int AS lead_with_dept,
           (SELECT count(*) FROM public.orders o
             WHERE o.status::text IN ('confirmed', 'shipped', 'paid', 'returned')
               AND coalesce(o.sold_at, o.created_at) >= now() - interval '60 days'
               AND public.order_dept_by_team(o.sale_source, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)) IS NOT NULL
               AND public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override)
                   IS DISTINCT FROM public.order_dept_by_team(o.sale_source, o.sold_by_person_id, coalesce(o.sold_at, o.created_at)))::int AS off_team`);
  c.tie('order_dept_by_team: a lead (altercpa) first', true, d?.lead_first === true);
  c.tie('AlterCPA leads with a stored department', 0, d?.lead_with_dept);
  c.tie("real sales (60 days) of line members outside their team's department", 0, d?.off_team);
}

// ── T4: the teams table ───────────────────────────────────────────────────────
async function verifyTeamsTable() {
  const c = check('T4', 'sales_teams kinds and lanes');
  const teams = await timed('teams', `SELECT key, kind, sort_order, leaderboard_mode FROM public.sales_teams ORDER BY sort_order, key`);
  const kind = Object.fromEntries(teams.map((t) => [t.key, t.kind]));
  c.info('teams', teams.map((t) => `${t.key}=${t.kind}/${t.sort_order}`).join(' · '));
  c.tie('teleshop / affiliate / management / altercpa_leads / crm_prediction kinds',
    ['line', 'line', 'management', 'legacy', 'legacy'],
    [kind.teleshop, kind.affiliate, kind.management, kind.altercpa_leads, kind.crm_prediction]);
  const [bad] = await timed('lanes', `
    SELECT count(*) FILTER (WHERE m.lane IS NOT NULL AND st.kind <> 'line') AS lane_off_line,
           count(*) FILTER (WHERE m.lane = 'social' AND m.team_key <> 'teleshop') AS social_off_teleshop,
           count(*) FILTER (WHERE m.lane IS NULL AND st.kind = 'line') AS line_without_lane
    FROM public.sales_team_members m JOIN public.sales_teams st ON st.key = m.team_key`);
  c.tie('memberships with a lane on a non-line team', 0, n(bad.lane_off_line));
  c.tie("memberships with 'social' outside teleshop", 0, n(bad.social_off_teleshop));
  if (n(bad.line_without_lane)) c.warn('line memberships without a lane', n(bad.line_without_lane));
}

// ── T5: the proposal's counts = an order-by-order recount ─────────────────────
async function verifyProposalCounts() {
  const c = check('T5', 'sales_team_line_proposal(60): window counts = a per-order recount (4-argument cohort_order_source)');
  const [p] = await timed('proposal', `SELECT public.sales_team_line_proposal(60) AS doc`);
  const doc = parse(p.doc);
  const since = doc.since;
  const recount = await timed('recount', `
    WITH xp AS (SELECT public.report_excluded_phone8s() AS p8)
    SELECT o.sold_by_person_id AS pid,
           public.cohort_order_source(o.sale_source, o.sale_source_detail, o.mex_tracking_id, o.dept_override) AS dept,
           count(*) AS n
    FROM public.orders o, xp
    WHERE o.sold_by_person_id IS NOT NULL
      AND o.status::text IN ('confirmed', 'shipped', 'delivered', 'paid', 'returned')
      AND coalesce(o.sold_at, o.created_at) >= ${lit(since)}::timestamptz
      AND right(regexp_replace(coalesce(o.customer_phone, ''), '[^0-9]', '', 'g'), 8) <> ALL (coalesce(xp.p8, ARRAY[]::text[]))
    GROUP BY 1, 2`);
  const byPerson = new Map();
  for (const r of recount) {
    const m = byPerson.get(r.pid) ?? {};
    m[r.dept ?? 'other'] = (m[r.dept ?? 'other'] ?? 0) + n(r.n);
    byPerson.set(r.pid, m);
  }
  let checked = 0;
  const wrong = [];
  for (const row of doc.rows ?? []) {
    if (row.span !== 'window') continue;
    checked++;
    const m = byPerson.get(row.person_id) ?? {};
    for (const d of ['altercpa', 'elyon_crm', 'teleshop_other', 'teleshop_out', 'social']) {
      if (n(m[d]) !== n(row.counts?.[d])) wrong.push(`${row.display_name} ${d}: proposal ${n(row.counts?.[d])} ≠ recount ${n(m[d])}`);
    }
  }
  c.info('people compared (window span)', checked);
  c.info('summary', doc.summary);
  c.tie('per-person, per-department differences', [], wrong.slice(0, 30));
}

async function main() {
  const json = process.argv.includes('--json');
  const di = process.argv.indexOf('--day');
  let day = di > 0 ? process.argv[di + 1] : null;
  if (day && !YMD.test(day)) { console.error('verify-teams: --day YYYY-MM-DD'); process.exit(2); }
  const [have] = await runSql(`
    SELECT to_regprocedure('public.sales_team_line_proposal(integer)') IS NOT NULL AS proposal,
           to_regprocedure('public.sales_team_filter_matches(text,text,text)') IS NOT NULL AS filter,
           EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public' AND table_name = 'sales_team_members' AND column_name = 'lane') AS lane,
           ((now() AT TIME ZONE 'Europe/Skopje')::date - 1)::text AS yesterday`);
  const missing = ['proposal', 'filter', 'lane'].filter((k) => !have[k]);
  if (missing.length) {
    console.error(`verify-teams: not applied yet (${missing.join(', ')}) — apply 20260943000900 and 20260943000950 first`);
    process.exit(2);
  }
  day = day ?? have.yesterday;
  await verifyMemberships();
  await verifyAliases(day);
  await verifyDepartmentsIgnoreTeams();
  await verifyTeamsTable();
  await verifyProposalCounts();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-teams', read_only: true, generated_at: new Date().toISOString(), day, status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log(`verify-teams · read-only · Macedonia · board day ${day}`);
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

main().catch((e) => { console.error(`verify-teams error: ${e?.message ?? e}`); process.exit(2); });
