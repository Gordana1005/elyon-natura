#!/usr/bin/env node
/**
 * gen-rls-initplan — READ-ONLY generator of the "RLS in InitPlan form" migration (01.10.2026).
 *
 *   node scripts/gen-rls-initplan.mjs                 (writes the migration, prints the plan)
 *   node scripts/gen-rls-initplan.mjs --dry-run       (prints the plan, writes nothing)
 *   node scripts/gen-rls-initplan.mjs --self-test     (the rewriter's fixtures only, no network)
 *   node scripts/gen-rls-initplan.mjs --json=<file>   (also writes the plan as JSON)
 *
 * Reads every policy of schema public (pg_policy, pg_get_expr with search_path '' so every name is
 * schema-qualified), and for each USING / WITH CHECK that still calls auth.uid() / auth.jwt() /
 * auth.role() or a role helper per row, emits an ALTER POLICY whose expression wraps exactly those
 * calls in scalar sub-selects (lib/rls-initplan.mjs). Nothing else changes: not the name, the
 * command, the roles, permissive/restrictive, nor a byte of the rest of the expression.
 *
 * Before writing, it proves for every rewritten policy:
 *   G1  normalise(new) === normalise(old)  (only wrappers were added)
 *   G2  the new text has no per-row call left, and rewriting it again changes nothing
 *   G3  every wrapped function is STABLE/IMMUTABLE in pg_proc (a VOLATILE one would refuse)
 *   G4  the SQL normaliser of the migration's drift guard agrees with normalise() on every live
 *       policy and on the predicted deparse of every new expression (so a re-run passes the guard)
 *   G5  every new expression parses and plans: EXPLAIN SELECT 1 FROM <table> WHERE <new> (read-only)
 *
 * Output: supabase/migrations/20260944000460_rls_initplan_all.sql. Excludes orders / order_items
 * (done by 20260944000450). Pinned to Macedonia; the database is only ever read.
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  rewriteExpr, normalise, predictDeparse, hasPerRowCall, WRAPPABLE, sqlNormaliseExpr, mkClient,
} from './lib/rls-initplan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATION = join(ROOT, 'supabase', 'migrations', '20260944000460_rls_initplan_all.sql');
const EXCLUDED_TABLES = new Set(['orders', 'order_items']);   // 20260944000450
const PROBE_UID = '812925d3-e732-4e0b-887c-6f58858dd43a';     // pregled.agent — only to PLAN as authenticated

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(`--${n}`);
const opt = (n) => argv.find((a) => a.startsWith(`--${n}=`))?.split('=').slice(1).join('=');

// ── self-test fixtures (no network) ─────────────────────────────────────────────────────────────
const FIXTURES = [
  ['(agent_id = auth.uid())', '(agent_id = (SELECT auth.uid()))'],
  ["public.has_role(auth.uid(), 'admin'::public.app_role)",
    "(SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role))"],
  ['public.is_admin_or_manager(auth.uid())', '(SELECT public.is_admin_or_manager((SELECT auth.uid())))'],
  ['(affiliate_id = public.get_my_affiliate_id())', '(affiliate_id = (SELECT public.get_my_affiliate_id()))'],
  ['( SELECT public.is_business_owner(auth.uid()) AS is_business_owner)', null],      // already InitPlan
  ['(user_id = ( SELECT auth.uid() AS uid))', null],                                    // already InitPlan
  ["((user_id = auth.uid()) OR public.has_role(auth.uid(), 'admin'::public.app_role))",
    "((user_id = (SELECT auth.uid())) OR (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)))"],
  ['(EXISTS ( SELECT 1\n   FROM public.orders\n  WHERE ((orders.id = order_notes.order_id) AND (orders.assigned_agent_id = auth.uid()))))',
    '(EXISTS ( SELECT 1\n   FROM public.orders\n  WHERE ((orders.id = order_notes.order_id) AND (orders.assigned_agent_id = (SELECT auth.uid())))))'],
  ["public.has_role(user_id, 'admin'::public.app_role)", null],                         // row argument: never wrapped
  ["(note = 'auth.uid()'::text)", null],                                                 // inside a literal: untouched
];

function selfTest() {
  let bad = 0;
  for (const [src, want] of FIXTURES) {
    const r = rewriteExpr(src);
    const got = r.changed ? r.text : null;
    const ok = got === want
      && normalise(r.text) === normalise(src)
      && !hasPerRowCall(r.text)
      && (want == null || normalise(predictDeparse(r.text)) === normalise(src));
    if (!ok) { bad++; console.error(`✗ ${JSON.stringify(src)}\n   want ${JSON.stringify(want)}\n   got  ${JSON.stringify(got)}`); }
  }
  console.log(bad ? `self-test: ${bad} FAILED` : `self-test: ${FIXTURES.length} fixtures ok`);
  return bad === 0;
}

// ── SQL text helpers ────────────────────────────────────────────────────────────────────────────
const lit = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const qident = (s) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const qpolicy = (s) => `"${s.replace(/"/g, '""')}"`;
/** A dollar-quote tag that does not occur in the text. */
function dq(text, base = 'o') {
  if (text == null) return 'NULL';
  let tag = base;
  for (let n = 0; text.includes(`$${tag}$`); n++) tag = `${base}${n}`;
  return `$${tag}$${text}$${tag}$`;
}
const CMD = { r: 'SELECT', a: 'INSERT', w: 'UPDATE', d: 'DELETE', '*': 'ALL' };
const oneLine = (s) => (s == null ? '—' : s.replace(/\s+/g, ' '));

async function main() {
  if (!selfTest()) process.exit(1);
  if (flag('self-test')) return;
  const db = mkClient();

  // G3 — every wrappable function exists and none is VOLATILE
  const procs = await db.select(`
    SELECT n.nspname || '.' || p.proname AS name, p.provolatile AS vol, pg_catalog.pg_get_function_identity_arguments(p.oid) AS args
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname || '.' || p.proname IN (${[...WRAPPABLE].map(lit).join(', ')})`);
  const missing = [...WRAPPABLE].filter((f) => !procs.some((p) => p.name === f));
  const volatile = procs.filter((p) => p.vol === 'v');
  if (missing.length) console.log(`note: not in this database (ignored): ${missing.join(', ')}`);
  if (volatile.length) throw new Error(`G3: VOLATILE wrappable function(s): ${volatile.map((p) => `${p.name}(${p.args})`).join(', ')} — wrapping would change semantics`);

  const policies = await db.select(`
    SELECT c.relname AS tbl, p.polname AS name, p.polcmd AS cmd, p.polpermissive AS permissive,
           pg_catalog.pg_get_expr(p.polqual, p.polrelid) AS qual,
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid) AS wc
      FROM pg_catalog.pg_policy p
      JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
     ORDER BY c.relname, p.polname`);

  const plan = [];
  const skipped = [];
  const notes = [];
  for (const p of policies) {
    const u = rewriteExpr(p.qual);
    const w = rewriteExpr(p.wc);
    for (const n of [...u.notes, ...w.notes]) notes.push(`${p.tbl} · ${p.name}: ${n}`);
    if (!u.changed && !w.changed) {
      const why = (p.qual ?? '') + (p.wc ?? '');
      skipped.push({ tbl: p.tbl, name: p.name, why: /auth\.|public\./.test(why) ? 'already InitPlan form' : 'no auth call' });
      continue;
    }
    if (EXCLUDED_TABLES.has(p.tbl)) { skipped.push({ tbl: p.tbl, name: p.name, why: 'EXCLUDED (20260944000450) — still has a per-row call!' }); continue; }
    // G1 / G2
    if (normalise(u.text) !== normalise(p.qual) || normalise(w.text) !== normalise(p.wc)) throw new Error(`G1 failed: ${p.tbl} · ${p.name}`);
    if (hasPerRowCall(u.text) || hasPerRowCall(w.text)) throw new Error(`G2 failed: ${p.tbl} · ${p.name}`);
    plan.push({
      tbl: p.tbl, name: p.name, cmd: p.cmd, permissive: p.permissive,
      old_using: p.qual, old_check: p.wc,
      new_using: u.changed ? u.text : null, new_check: w.changed ? w.text : null,
      wrapped: [...u.wrapped, ...w.wrapped],
    });
  }

  // G4 — the migration's SQL normaliser agrees with normalise() on live texts + predicted deparse
  const probe = [];
  for (const p of policies) for (const e of [p.qual, p.wc]) if (e != null) probe.push({ e, want: normalise(e) });
  for (const q of plan) {
    if (q.new_using) probe.push({ e: predictDeparse(q.new_using), want: normalise(q.old_using) });
    if (q.new_check) probe.push({ e: predictDeparse(q.new_check), want: normalise(q.old_check) });
  }
  const g4 = await db.select(`
    SELECT x.ord::int AS i, ${sqlNormaliseExpr("(x.v->>'e')")} AS got, regexp_replace(x.v->>'want', '\\s+', ' ', 'g') AS want
      FROM jsonb_array_elements(${lit(JSON.stringify(probe))}::jsonb) WITH ORDINALITY AS x(v, ord)`);
  const g4bad = g4.filter((r) => r.got !== r.want);
  if (g4bad.length) throw new Error(`G4: SQL normaliser disagrees on ${g4bad.length} text(s), e.g. ${JSON.stringify(g4bad[0])}`);

  // G5 — every new expression parses and plans against its table (EXPLAIN only, read-only role)
  if (!flag('no-explain')) {
    const byTable = new Map();
    for (const q of plan) for (const e of [q.new_using, q.new_check]) if (e) (byTable.get(q.tbl) ?? byTable.set(q.tbl, []).get(q.tbl)).push(e);
    let asAuth = 0;
    for (const [tbl, exprs] of byTable) {
      const sql = `EXPLAIN (COSTS OFF) SELECT 1 FROM public.${qident(tbl)} WHERE ${exprs.map((e) => `(${e})`).join(' OR ')}`;
      try {
        await db.select(sql);
      } catch (e) {
        // the read-only role has no EXECUTE on is_business_owner(): plan it as `authenticated`
        if (!/permission denied for function/.test(e.message)) throw new Error(`G5 ${tbl}: ${e.message}`);
        const r = await db.asUser(PROBE_UID, sql);
        if (r.error) throw new Error(`G5 ${tbl} (as authenticated): ${r.error}`);
        asAuth++;
      }
    }
    console.log(`G5: ${byTable.size} tables — every new expression parses and plans (${asAuth} planned as authenticated)`);
  }

  // ── report ──
  const tables = [...new Set(plan.map((q) => q.tbl))];
  console.log(`\npolicies in public: ${policies.length} · rewritten: ${plan.length} on ${tables.length} tables · unchanged: ${skipped.length}`);
  for (const q of plan) {
    console.log(`\n${q.tbl} · "${q.name}" (${CMD[q.cmd]})`);
    if (q.new_using) console.log(`  USING  ${oneLine(q.old_using)}\n      →  ${oneLine(q.new_using)}`);
    if (q.new_check) console.log(`  CHECK  ${oneLine(q.old_check)}\n      →  ${oneLine(q.new_check)}`);
  }
  console.log('\nunchanged:');
  for (const s of skipped) console.log(`  ${s.tbl} · "${s.name}" — ${s.why}`);
  if (notes.length) { console.log('\nnotes:'); for (const n of notes) console.log(`  ${n}`); }
  if (opt('json')) writeFileSync(opt('json'), JSON.stringify({ generated_at: new Date().toISOString(), plan, skipped, notes }, null, 1));
  if (skipped.some((s) => s.why.startsWith('EXCLUDED'))) throw new Error('orders / order_items still have a per-row call — look before generating');

  if (flag('dry-run')) { console.log('\n(dry run — migration not written)'); return; }
  writeFileSync(MIGRATION, renderMigration(plan, tables, policies.length));
  console.log(`\nwrote ${MIGRATION}`);
}

function renderMigration(plan, tables, total) {
  const L = [];
  L.push(`-- ============================================================================
-- RLS in InitPlan form — every remaining per-row auth.uid() / role-helper call
-- (01.10.2026 — after the agents' order-search timeout, 20260944000450)
-- ============================================================================
-- GENERATED by scripts/gen-rls-initplan.mjs from the live policies (pg_get_expr, search_path '').
-- Do not hand-edit: regenerate. Verify with scripts/verify-rls-initplan.mjs.
--
-- Why: a policy that calls auth.uid() or has_role(auth.uid(), …) / is_admin_or_manager(auth.uid())
-- / is_internal_staff(auth.uid()) / get_my_affiliate_id() directly is evaluated PER ROW whenever
-- the query also has a non-leakproof predicate (LIKE, ILIKE, most functions): Postgres must apply
-- the RLS quals first. On 01.10 that turned an agent's phone search on orders into ~358k
-- has_role() calls and a statement timeout. Wrapping each call in a scalar sub-select —
-- (SELECT auth.uid()), (SELECT public.has_role((SELECT auth.uid()), 'admin'::public.app_role)) —
-- lets the planner compute it ONCE per query (an InitPlan).
--
-- WHO SEES / WRITES WHAT DOES NOT CHANGE. Only those calls are wrapped; each is STABLE and gets no
-- column of the row (auth.uid() or a constant only), so its value is the same for every row of a
-- statement. ALTER POLICY keeps the name, command, roles and permissive/restrictive; a USING or
-- WITH CHECK that needs no change is not restated. Policies already in InitPlan form (e.g. the
-- (SELECT is_business_owner(…)) ones, web_sync_runs, orders / order_items) are untouched.
--
-- Scope: ${plan.length} of the ${total} policies of schema public, on ${tables.length} tables. orders / order_items excluded (done).
--
-- How it runs (node scripts/apply-migration-mk.mjs 20260944000460_rls_initplan_all.sql):
--   * ONE transaction per table with SET LOCAL lock_timeout = '5s' — ALTER POLICY needs an
--     ACCESS EXCLUSIVE lock, and the syncs write constantly. A table that stays busy for 5 s is
--     skipped (its block catches lock_not_available) so the others still go through. While the
--     ALTER waits for its lock, new reads of that table queue behind it (≤ 5 s): on user_roles
--     (read by every has_role()) and profiles that is a short app-wide pause — apply in the
--     quiet window after 20:55 Skopje.
--   * Drift guard: before altering, each policy's live expression must still be the one this file
--     was generated from (whitespace and InitPlan wrappers aside). If another session changed a
--     policy since, the run STOPS with "rls_initplan: … changed since generation" — regenerate.
--   * At the end, if any table was skipped, the run raises "rls_initplan: lock timeout on: …" so
--     apply-migration-mk does NOT record the version. Just run the same command again (best in the
--     quiet window after 20:55 Skopje): the tables already done pass the guard and are re-set to
--     the same text, harmlessly. ALTER POLICY is idempotent.
-- ============================================================================

-- session scratch (pg_temp: gone when the connection closes)
SELECT pg_catalog.set_config('elyon.rls_initplan_busy', '', false);

CREATE OR REPLACE FUNCTION pg_temp.rls_initplan_norm(e text) RETURNS text
LANGUAGE sql IMMUTABLE AS $f$
  SELECT ${sqlNormaliseExpr('e')}
$f$;

CREATE OR REPLACE FUNCTION pg_temp.rls_initplan_guard(p_table text, p_policy text, p_using text, p_check text)
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $f$
DECLARE
  q text;
  w text;
BEGIN
  SELECT pg_catalog.pg_get_expr(p.polqual, p.polrelid), pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
    INTO q, w
    FROM pg_catalog.pg_policy p
   WHERE p.polrelid = pg_catalog.to_regclass('public.' || pg_catalog.quote_ident(p_table))
     AND p.polname = p_policy;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rls_initplan: policy "%" on public.% is gone - regenerate (node scripts/gen-rls-initplan.mjs)', p_policy, p_table;
  END IF;
  IF pg_temp.rls_initplan_norm(q) IS DISTINCT FROM pg_temp.rls_initplan_norm(p_using)
     OR pg_temp.rls_initplan_norm(w) IS DISTINCT FROM pg_temp.rls_initplan_norm(p_check) THEN
    RAISE EXCEPTION 'rls_initplan: policy "%" on public.% changed since generation - regenerate (node scripts/gen-rls-initplan.mjs)', p_policy, p_table;
  END IF;
END
$f$;

CREATE OR REPLACE FUNCTION pg_temp.rls_initplan_busy(p_table text) RETURNS void
LANGUAGE plpgsql AS $f$
BEGIN
  RAISE NOTICE 'rls_initplan: public.% busy (lock timeout) - not changed, re-run', p_table;
  PERFORM pg_catalog.set_config('elyon.rls_initplan_busy',
    pg_catalog.concat_ws(' ', NULLIF(pg_catalog.current_setting('elyon.rls_initplan_busy', true), ''), p_table), false);
END
$f$;
`);

  for (const tbl of tables) {
    const qs = plan.filter((q) => q.tbl === tbl);
    L.push(`-- ── public.${tbl} ${'─'.repeat(Math.max(4, 70 - tbl.length))}`);
    L.push('BEGIN;');
    L.push(`SET LOCAL lock_timeout = '5s';`);
    L.push('DO $rls$');
    L.push('BEGIN');
    for (const q of qs) {
      L.push(`  PERFORM pg_temp.rls_initplan_guard(${lit(tbl)}, ${lit(q.name)},`);
      L.push(`    ${dq(q.old_using)},`);
      L.push(`    ${dq(q.old_check)});`);
    }
    for (const q of qs) {
      L.push(`  ALTER POLICY ${qpolicy(q.name)} ON public.${qident(tbl)}`);
      const parts = [];
      if (q.new_using) parts.push(`    USING (${q.new_using})`);
      if (q.new_check) parts.push(`    WITH CHECK (${q.new_check})`);
      L.push(`${parts.join('\n')};`);
    }
    L.push('EXCEPTION WHEN lock_not_available THEN');
    L.push(`  PERFORM pg_temp.rls_initplan_busy(${lit(tbl)});`);
    L.push('END');
    L.push('$rls$;');
    L.push('COMMIT;');
    L.push('');
  }

  L.push(`-- ── done ────────────────────────────────────────────────────────────────────
BEGIN;
NOTIFY pgrst, 'reload schema';
COMMIT;

DO $done$
DECLARE
  busy text := pg_catalog.btrim(COALESCE(pg_catalog.current_setting('elyon.rls_initplan_busy', true), ''));
BEGIN
  IF busy <> '' THEN
    RAISE EXCEPTION 'rls_initplan: lock timeout on: % - every other table is done; run the same apply command again', busy;
  END IF;
END
$done$;
`);
  return L.join('\n');
}

main().catch((e) => { console.error(`✗ ${e.message}`); process.exit(1); });
