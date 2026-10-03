#!/usr/bin/env node
/**
 * scripts/db-move/sync-acls.mjs — make the NEW project's privileges equal the OLD project's (03.10.2026).
 *
 *   node scripts/db-move/sync-acls.mjs [--apply]
 *
 * Why: pg_dump writes an object's ACL as GRANT/REVOKE statements relative to the built-in defaults, but Supabase
 * projects carry ALTER DEFAULT PRIVILEGES (every new function gets EXECUTE for anon / authenticated /
 * service_role, every table ALL for them). A function the source had REVOKEd from anon / authenticated therefore
 * comes back CALLABLE on the restored copy — verify-address-routing R7 caught it. This script compares the
 * aclitem[] of every public table, sequence, view and function on both projects and rewrites the NEW one to the
 * OLD one (dry run by default; --apply writes). RLS flags are compared and reported too.
 *
 * Tokens: SUPABASE_ACCESS_TOKEN (old, read-only query) and SUPABASE_ACCESS_TOKEN_NEW (new). Never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD_REF = 'bmfxhgznttcnnlqloqzp', NEW_REF = 'oufoazmnbwugtfldkwsn', BG_REF = 'sxymaloycddnoxudxaqp';
if ([OLD_REF, NEW_REF].includes(BG_REF)) throw new Error('refusing Bulgaria');
const APPLY = process.argv.includes('--apply');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const T = { OLD: [OLD_REF, env.SUPABASE_ACCESS_TOKEN], NEW: [NEW_REF, env.SUPABASE_ACCESS_TOKEN_NEW] };
async function q(which, query, ro = true) {
  const [ref, token] = T[which];
  if (which === 'OLD' && !ro) throw new Error('never write to the old project');
  const r = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ro ? { query, read_only: true } : { query }) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${which} ${r.status} ${t.slice(0, 400)}`);
  try { return JSON.parse(t); } catch { return t; }
}

const ACL_SQL = `
select 'r' as kind, c.relkind::text as sub, quote_ident(c.relname) as name, c.relacl::text[] as acl, c.relrowsecurity as rls, c.relforcerowsecurity as frls
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind in ('r','p','v','m','S')
union all
select 'f', p.prokind::text, quote_ident(p.proname) || '(' || pg_get_function_identity_arguments(p.oid) || ')', p.proacl::text[], null, null
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
const [oldRows, newRows] = await Promise.all([q('OLD', ACL_SQL), q('NEW', ACL_SQL)]);
const key = (r) => `${r.kind}:${r.name}`;
const byKey = (rows) => Object.fromEntries(rows.map((r) => [key(r), r]));
const O = byKey(oldRows), N = byKey(newRows);

const PRIV = { r: 'SELECT', w: 'UPDATE', a: 'INSERT', d: 'DELETE', D: 'TRUNCATE', x: 'REFERENCES', t: 'TRIGGER', X: 'EXECUTE', U: 'USAGE', m: 'MAINTAIN' };
const ROLES_TO_CLEAR = ['PUBLIC', 'anon', 'authenticated', 'service_role', 'supabase_read_only_user', 'authenticator', 'dashboard_user', 'supabase_privileged_role'];
const objSql = (r) => r.kind === 'f' ? `FUNCTION public.${r.name}` : r.sub === 'S' ? `SEQUENCE public.${r.name}` : `TABLE public.${r.name}`;
/** aclitem text "grantee=privs/grantor" → [grantee, privs]; grantee '' = PUBLIC. */
const parse = (item) => { const m = String(item).match(/^(?:"([^"]*)"|([^=]*))=([a-zA-Z*]*)\//); return m ? [m[1] ?? m[2] ?? '', m[3].replace(/\*/g, '')] : null; };
const norm = (acl) => (acl || []).map(parse).filter(Boolean).filter(([g]) => g !== 'postgres').map(([g, p]) => `${g || 'PUBLIC'}=${[...p].sort().join('')}`).sort().join(' ');

const stmts = [];
let diffs = 0, rlsDiffs = 0, missing = 0;
for (const [k, o] of Object.entries(O)) {
  const n = N[k];
  if (!n) { missing++; continue; }
  if (o.rls !== n.rls || o.frls !== n.frls) { rlsDiffs++; stmts.push(`-- RLS differs on ${o.name}: old rls=${o.rls} force=${o.frls}, new rls=${n.rls} force=${n.frls}`); if (o.rls) stmts.push(`ALTER TABLE public.${o.name} ENABLE ROW LEVEL SECURITY;`); else stmts.push(`ALTER TABLE public.${o.name} DISABLE ROW LEVEL SECURITY;`); if (o.frls) stmts.push(`ALTER TABLE public.${o.name} FORCE ROW LEVEL SECURITY;`); }
  if (norm(o.acl) === norm(n.acl)) continue;
  diffs++;
  const obj = objSql(o);
  stmts.push(`REVOKE ALL ON ${obj} FROM ${ROLES_TO_CLEAR.join(', ')};`);
  for (const item of o.acl || []) {
    const p = parse(item); if (!p) continue;
    const [grantee, privs] = p;
    if (grantee === 'postgres') continue;
    const names = [...privs].map((c) => PRIV[c]).filter(Boolean);
    if (!names.length) continue;
    stmts.push(`GRANT ${names.join(', ')} ON ${obj} TO ${grantee ? `"${grantee}"` : 'PUBLIC'};`);
  }
}
const out = join(ROOT, 'exports', 'db-move', '2026-10-03', 'sync-acls.sql');
writeFileSync(out, stmts.join('\n') + '\n');
console.log(`objects compared: ${Object.keys(O).length} (old) vs ${Object.keys(N).length} (new); missing on new: ${missing}; ACL differences: ${diffs}; RLS differences: ${rlsDiffs}; statements: ${stmts.length} → ${out}`);
const byKind = {};
for (const [k, o] of Object.entries(O)) { const n = N[k]; if (n && norm(o.acl) !== norm(n.acl)) byKind[o.kind === 'f' ? 'functions' : o.sub === 'S' ? 'sequences' : o.sub === 'v' ? 'views' : 'tables'] = (byKind[o.kind === 'f' ? 'functions' : o.sub === 'S' ? 'sequences' : o.sub === 'v' ? 'views' : 'tables'] || 0) + 1; }
console.log('differences by kind:', JSON.stringify(byKind));
if (!APPLY) { console.log('dry run — rerun with --apply to write to the NEW project'); process.exit(0); }
if (!stmts.length) process.exit(0);
await q('NEW', stmts.filter((s) => !s.startsWith('--')).join('\n'), false);
const [newAfter] = [await q('NEW', ACL_SQL)];
const NA = byKey(newAfter);
let left = 0;
for (const [k, o] of Object.entries(O)) { const n = NA[k]; if (n && norm(o.acl) !== norm(n.acl)) { left++; if (left <= 5) console.log('  still differs:', o.name, '| old', norm(o.acl), '| new', norm(n.acl)); } }
console.log(`applied; ACL differences left: ${left}`);
process.exit(left ? 1 : 0);
