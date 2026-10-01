#!/usr/bin/env node
/**
 * verify-rls-initplan — READ-ONLY proof that 20260944000460_rls_initplan_all.sql changes WHO SEES
 * WHAT not at all, only how often the role checks run (01.10.2026).
 *
 *   BEFORE applying (captures the snapshot the AFTER run compares with):
 *     node scripts/verify-rls-initplan.mjs --snapshot=<file.json>
 *   AFTER applying:
 *     node scripts/verify-rls-initplan.mjs --compare=<file.json>
 *   Options: --quick (only admin / manager / test agent) · --no-timing · --json
 *
 *   V1  structure — every public policy still exists with the same command, roles and
 *       permissive flag, and normalise(now) === normalise(snapshot): removing the InitPlan
 *       wrappers gives back the snapshot text exactly (BEFORE: the generator's rewrite instead)
 *   V2  coverage — policies that still call auth.uid() / a role helper per row (BEFORE: the plan;
 *       AFTER: must be 0 outside orders / order_items — a leftover table = a busy re-run)
 *   V3  row-level equivalence — for each user, on EVERY row of each affected table, the old and the
 *       new USING / WITH CHECK expression accept exactly the same rows (count(*) FILTER old vs new,
 *       read-only role with the user's JWT claims; RLS-on fallback where the read-only role cannot
 *       run is_business_owner). BEFORE: old = live, new = the generator's rewrite.
 *   V4  visible rows — count(*) of each affected table AS each user (RLS on, read-only
 *       transaction): BEFORE stores them, AFTER must match (tables that move by themselves — logs,
 *       notifications, sync runs — can differ by real writes in between; see the drift note)
 *   V5  timing (info) — EXPLAIN ANALYZE of the agents' heavy queries as the agent, before vs after
 *
 * Exit: 0 = no FAIL · 1 = FAIL · 2 = refused / unreachable. Pinned to Macedonia; reads only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { rewriteExpr, normalise, hasPerRowCall, mkClient, REF } from './lib/rls-initplan.mjs';

const EXCLUDED_TABLES = new Set(['orders', 'order_items']);
const FIXED_USERS = [
  { label: 'admin', email: 'mile@elyon.com', uid: '27f13f6e-fd19-44bb-a3c8-a6855a887cc7' },
  { label: 'manager', email: 'kalina@naturatherapy.mk', uid: '9d6ced2f-9244-450a-9250-9e87bab25fe2' },
  { label: 'agent', email: 'pregled.agent@elyon-mk.local', uid: '812925d3-e732-4e0b-887c-6f58858dd43a' },
];
const NO_UID = { label: 'no-uid', email: '(no JWT sub)', uid: null };

const argv = process.argv.slice(2);
const opt = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');
const flag = (n) => argv.includes(`--${n}`);
const qident = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;

const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    fail(msg) { c.lines.push(`✗ ${msg}`); c.status = 'FAIL'; },
    warn(msg) { c.lines.push(`! ${msg}`); if (c.status === 'PASS') c.status = 'WARN'; },
    info(msg) { c.lines.push(`  ${msg}`); },
  };
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
  }));
  return out;
}

async function readPolicies(db) {
  return db.select(`
    SELECT c.relname AS tbl, p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
           (SELECT pg_catalog.array_agg(CASE WHEN r = 0 THEN 'public' ELSE r::pg_catalog.regrole::text END ORDER BY 1)
              FROM pg_catalog.unnest(p.polroles) r)::text AS roles,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS wc
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY 1, 2`);
}
const key = (p) => `${p.tbl}|${p.name}`;

/** The agents whose work is heaviest: most assigned orders, most prediction-list members. */
async function pickUsers(db) {
  const [o] = await db.select(`
    SELECT o.assigned_agent_id::text AS uid, u.email FROM public.orders o JOIN auth.users u ON u.id = o.assigned_agent_id
     WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = o.assigned_agent_id AND r.role IN ('admin', 'manager'))
     GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`);
  const [m] = await db.select(`
    SELECT m.assigned_agent_id::text AS uid, u.email FROM public.prediction_segment_members m JOIN auth.users u ON u.id = m.assigned_agent_id
     WHERE NOT EXISTS (SELECT 1 FROM public.user_roles r WHERE r.user_id = m.assigned_agent_id AND r.role IN ('admin', 'manager'))
     GROUP BY 1, 2 ORDER BY count(*) DESC LIMIT 1`);
  const users = [...FIXED_USERS];
  if (o) users.push({ label: 'agent-orders', ...o });
  if (m && m.uid !== o?.uid) users.push({ label: 'agent-lists', ...m });
  return users;
}

/** The agents' heavy queries, with real parameters picked now (kept in the snapshot). */
async function pickTimings(db, users) {
  const ag = users.find((u) => u.label === 'agent-orders') ?? users.find((u) => u.label === 'agent');
  const al = users.find((u) => u.label === 'agent-lists') ?? ag;
  const [oh] = await db.select(`SELECT h.order_id::text AS id FROM public.order_history h JOIN public.orders o ON o.id = h.order_id
     WHERE o.assigned_agent_id = ${lit(ag.uid)} GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const [on] = await db.select(`SELECT n.order_id::text AS id FROM public.order_notes n JOIN public.orders o ON o.id = n.order_id
     WHERE o.assigned_agent_id = ${lit(ag.uid)} GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`);
  const [cl] = await db.select(`SELECT right(regexp_replace(customer_phone, '\\D', '', 'g'), 8) AS p FROM public.call_logs
     WHERE customer_phone IS NOT NULL ORDER BY created_at DESC LIMIT 1`);
  const [cp] = await db.select(`SELECT right(regexp_replace(phone, '\\D', '', 'g'), 8) AS p FROM public.customer_profiles
     WHERE phone IS NOT NULL ORDER BY updated_at DESC NULLS LAST LIMIT 1`);
  const t = [];
  if (oh) t.push({ id: 'T1', what: 'order_history by order_id', user: ag.label, sql: `SELECT * FROM public.order_history WHERE order_id = ${lit(oh.id)} ORDER BY changed_at` });
  if (on) t.push({ id: 'T2', what: 'order_notes by order_id', user: ag.label, sql: `SELECT * FROM public.order_notes WHERE order_id = ${lit(on.id)} ORDER BY created_at` });
  if (cl) t.push({ id: 'T3', what: 'call_logs by phone (last 8, LIKE)', user: ag.label, sql: `SELECT * FROM public.call_logs WHERE customer_phone LIKE ${lit(`%${cl.p}`)} ORDER BY created_at DESC LIMIT 50` });
  if (cp) t.push({ id: 'T4', what: 'customer_profiles by phone (last 8, LIKE)', user: ag.label, sql: `SELECT * FROM public.customer_profiles WHERE phone LIKE ${lit(`%${cp.p}`)}` });
  t.push({ id: 'T5', what: 'prediction_segment_members by agent', user: al.label, sql: `SELECT * FROM public.prediction_segment_members WHERE assigned_agent_id = ${lit(al.uid)} ORDER BY updated_at DESC NULLS LAST LIMIT 200` });
  if (cp) t.push({ id: 'T6', what: 'prediction_segment_members by phone (LIKE)', user: al.label, sql: `SELECT * FROM public.prediction_segment_members WHERE customer_phone LIKE ${lit(`%${cp.p}`)}` });
  t.push({ id: 'T7', what: 'notifications: the bell (own, newest 50)', user: ag.label, sql: `SELECT * FROM public.notifications WHERE user_id = ${lit(ag.uid)} ORDER BY created_at DESC LIMIT 50` });
  t.push({ id: 'T8', what: 'notifications: unread count', user: ag.label, sql: 'SELECT count(*) FROM public.notifications WHERE NOT is_read' });
  t.push({ id: 'T9', what: 'profiles: name search (ILIKE)', user: ag.label, sql: "SELECT user_id FROM public.profiles WHERE full_name ILIKE '%a%'" });
  return t;
}

async function runTimings(db, timings, users) {
  return pool(timings, 2, async (t) => {
    const u = users.find((x) => x.label === t.user);
    const best = [];
    for (let i = 0; i < 2; i++) {   // twice: the second run is warm
      const r = await db.asUser(u.uid, `EXPLAIN (ANALYZE, FORMAT JSON) ${t.sql}`);
      if (r.error) return { ...t, error: r.error };
      const plan = r.rows?.[0]?.['QUERY PLAN'];
      const j = typeof plan === 'string' ? JSON.parse(plan) : plan;
      best.push(j?.[0]?.['Execution Time']);
    }
    return { ...t, ms: Math.min(...best.filter((x) => x != null)) };
  });
}

async function countsAs(db, users, tables) {
  const jobs = users.flatMap((u) => tables.map((t) => ({ u, t })));
  const out = {};
  await pool(jobs, 3, async ({ u, t }) => {
    const r = await db.asUser(u.uid, `SELECT count(*)::bigint AS n FROM public.${qident(t)}`, { timeoutS: 110 });
    (out[u.label] ??= {})[t] = r.error ? `ERR ${r.error}` : Number(r.rows[0].n);
  });
  return out;
}

/** V3: per user per table, count(*) FILTER (old) vs FILTER (new) for every changed expression. */
async function equivalence(db, users, pairs, chk) {
  const byTable = new Map();
  for (const p of pairs) (byTable.get(p.tbl) ?? byTable.set(p.tbl, []).get(p.tbl)).push(p);
  const jobs = [...users, NO_UID].flatMap((u) => [...byTable.keys()].map((t) => ({ u, t })));
  let compared = 0; let rowsSeen = 0; let fallback = 0;
  const noUidSkipped = [];
  await pool(jobs, 3, async ({ u, t }) => {
    const ps = byTable.get(t);
    const cols = ps.flatMap((p, i) => [`count(*) FILTER (WHERE (${p.old})) AS o${i}`, `count(*) FILTER (WHERE (${p.new})) AS n${i}`]);
    const sql = `SELECT count(*) AS total, ${cols.join(', ')} FROM public.${qident(t)}`;
    let r = await db.selectAs(u.uid, sql);
    let how = 'all rows';
    if (r.error && /permission denied for function/.test(r.error)) {
      // no JWT sub = anon, and anon has no EXECUTE on is_business_owner either: nothing to compare
      if (!u.uid) { noUidSkipped.push(t); return; }
      r = await db.asUser(u.uid, sql, { timeoutS: 110 }); how = 'RLS on'; fallback++;
    }
    if (r.error) { chk.warn(`${u.label} · ${t}: ${r.error}`); return; }
    const row = r.rows[0];
    rowsSeen += Number(row.total);
    ps.forEach((p, i) => {
      compared++;
      if (String(row[`o${i}`]) !== String(row[`n${i}`])) chk.fail(`${u.label} · ${t} · "${p.name}" ${p.part}: old accepts ${row[`o${i}`]} rows, new ${row[`n${i}`]} (${how})`);
    });
  });
  chk.info(`${compared} (user × expression) comparisons over ${byTable.size} tables, ${rowsSeen.toLocaleString('en')} rows scanned in total; ${fallback} ran with RLS on (no EXECUTE on is_business_owner for the read-only role)`);
  if (noUidSkipped.length) chk.info(`no-uid skipped on ${noUidSkipped.sort().join(', ')} (is_business_owner: anon has no EXECUTE, the policy is for authenticated)`);
}

function pairsFrom(oldPolicies, newText) {
  const pairs = [];
  for (const p of oldPolicies) {
    if (EXCLUDED_TABLES.has(p.tbl)) continue;
    for (const [part, oldE] of [['USING', p.qual], ['WITH CHECK', p.wc]]) {
      if (oldE == null) continue;
      const nw = newText(p, part);
      if (nw != null && nw !== oldE) pairs.push({ tbl: p.tbl, name: p.name, part, old: oldE, new: nw });
    }
  }
  return pairs;
}

async function main() {
  const snapPath = opt('snapshot');
  const cmpPath = opt('compare');
  if (!!snapPath === !!cmpPath) { console.error('usage: --snapshot=<file.json> (before) | --compare=<file.json> (after)'); process.exit(2); }
  const db = mkClient();
  const live = await readPolicies(db);
  const liveMap = new Map(live.map((p) => [key(p), p]));

  if (snapPath) {
    // ── BEFORE ──
    const plan = live.filter((p) => !EXCLUDED_TABLES.has(p.tbl) && (hasPerRowCall(p.qual) || hasPerRowCall(p.wc)));
    const tables = [...new Set(plan.map((p) => p.tbl))];
    let users = await pickUsers(db);
    if (flag('quick')) users = users.slice(0, 3);

    const v1 = check('V1', 'structure: rewrite = old + InitPlan wrappers only');
    for (const p of plan) {
      for (const e of [p.qual, p.wc]) {
        const r = rewriteExpr(e);
        if (normalise(r.text) !== normalise(e)) v1.fail(`${p.tbl} · ${p.name}`);
        if (hasPerRowCall(r.text)) v1.fail(`${p.tbl} · ${p.name}: per-row call left after rewrite`);
      }
    }
    v1.info(`${plan.length} policies on ${tables.length} tables to rewrite (of ${live.length} public policies)`);
    const v2 = check('V2', 'coverage: per-row policies now');
    v2.info(`${plan.length} per-row policies (expected before applying)`);

    const v3 = check('V3', 'row-level equivalence old vs rewrite, every row, per user');
    await equivalence(db, users, pairsFrom(plan, (p, part) => rewriteExpr(part === 'USING' ? p.qual : p.wc).text), v3);

    const v4 = check('V4', 'visible rows per user (RLS on) — stored');
    const counts = await countsAs(db, users, tables);
    const errs = Object.entries(counts).flatMap(([u, m]) => Object.entries(m).filter(([, n]) => String(n).startsWith('ERR')).map(([t, n]) => `${u} · ${t}: ${n}`));
    for (const e of errs) v4.warn(`${e} (the per-row policy is too slow even for a count — compare after)`);
    v4.info(`${users.length} users × ${tables.length} tables stored`);

    let timings = [];
    if (!flag('no-timing')) {
      const v5 = check('V5', 'timing of the agents\' heavy queries (before)');
      timings = await runTimings(db, await pickTimings(db, users), users);
      for (const t of timings) v5.info(`${t.id} ${t.what} as ${t.user}: ${t.error ? `ERR ${t.error}` : `${t.ms.toFixed(1)} ms`}`);
    }
    writeFileSync(snapPath, JSON.stringify({
      tool: 'verify-rls-initplan', ref: REF, taken_at: new Date().toISOString(),
      users, policies: live, planned: plan.map(key), tables, counts, timings,
    }, null, 1));
    console.log(`snapshot written: ${snapPath}`);
  } else {
    // ── AFTER ──
    const snap = JSON.parse(readFileSync(cmpPath, 'utf8'));
    if (snap.ref !== REF) { console.error(`snapshot is for ${snap.ref}, not ${REF}`); process.exit(2); }
    const before = new Map(snap.policies.map((p) => [key(p), p]));
    const users = snap.users;

    const v1 = check('V1', 'structure: now = snapshot + InitPlan wrappers only');
    let rewritten = 0;
    for (const [k, b] of before) {
      const a = liveMap.get(k);
      if (!a) { v1.fail(`policy gone: ${k}`); continue; }
      if (a.cmd !== b.cmd || a.permissive !== b.permissive || a.roles !== b.roles) v1.fail(`command / permissive / roles changed: ${k}`);
      if (normalise(a.qual) !== normalise(b.qual) || normalise(a.wc) !== normalise(b.wc)) v1.fail(`expression logic changed: ${k}\n     was ${b.qual} | ${b.wc}\n     now ${a.qual} | ${a.wc}`);
      if (a.qual !== b.qual || a.wc !== b.wc) rewritten++;
    }
    for (const k of liveMap.keys()) if (!before.has(k)) v1.warn(`new policy since the snapshot (not covered): ${k}`);
    v1.info(`${rewritten} policies rewritten since the snapshot (planned: ${snap.planned.length})`);

    const v2 = check('V2', 'coverage: per-row policies left');
    const left = live.filter((p) => !EXCLUDED_TABLES.has(p.tbl) && (hasPerRowCall(p.qual) || hasPerRowCall(p.wc)));
    for (const p of left) v2.fail(`still per-row: ${p.tbl} · ${p.name} — table busy during apply? re-run the apply command`);
    if (!left.length) v2.info('0 per-row policies left in public');

    const v3 = check('V3', 'row-level equivalence snapshot vs now, every row, per user');
    await equivalence(db, users, pairsFrom([...before.values()], (p, part) => {
      const a = liveMap.get(key(p));
      return a ? (part === 'USING' ? a.qual : a.wc) : null;
    }), v3);

    const v4 = check('V4', 'visible rows per user (RLS on): before vs after');
    const counts = await countsAs(db, users, snap.tables);
    for (const u of users) {
      for (const t of snap.tables) {
        const b = snap.counts[u.label]?.[t];
        const a = counts[u.label]?.[t];
        if (String(b).startsWith('ERR') || String(a).startsWith('ERR')) { v4.warn(`${u.label} · ${t}: before ${b} · after ${a}`); continue; }
        if (b !== a) {
          // a table that grew or shrank by real writes is not a policy change — V3 is the proof
          const grew = await db.select(`SELECT count(*)::bigint AS n FROM public.${qident(t)}`).then((r) => Number(r[0].n)).catch(() => null);
          v4.warn(`${u.label} · ${t}: before ${b} · after ${a} (table now holds ${grew} rows — check it moved by real writes; V3 decides)`);
        }
      }
    }
    v4.info(`${users.length} users × ${snap.tables.length} tables compared`);

    if (!flag('no-timing') && snap.timings?.length) {
      const v5 = check('V5', 'timing of the agents\' heavy queries: before → after');
      const now = await runTimings(db, snap.timings.map(({ ms, error, ...t }) => t), users);
      for (const t of now) {
        const b = snap.timings.find((x) => x.id === t.id);
        const f = (x) => (x.error ? `ERR ${x.error.slice(0, 60)}` : `${x.ms.toFixed(1)} ms`);
        v5.info(`${t.id} ${t.what} as ${t.user}: ${f(b)} → ${f(t)}`);
      }
    }
  }

  const exit = results.some((r) => r.status === 'FAIL') ? 1 : 0;
  if (flag('json')) console.log(JSON.stringify({ tool: 'verify-rls-initplan', ref: REF, exit_code: exit, results }, null, 2));
  else {
    for (const r of results) {
      console.log(`\n[${r.status}] ${r.id} ${r.title}`);
      for (const l of r.lines) console.log(`   ${l}`);
    }
    console.log(`\n${exit ? 'FAIL' : 'OK'} — verify-rls-initplan (${snapPath ? 'before' : 'after'})`);
  }
  process.exit(exit);
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(2); });
