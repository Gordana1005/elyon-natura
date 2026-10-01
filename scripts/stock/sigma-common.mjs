/**
 * Shared by the Stock v2 Sigma scripts (workstream S): mapping-apply, opening-apply, sigma-ingest-file,
 * sigma-month-check. Macedonia only — scripts/lib/repair-kit.mjs mkGuard() + assertRemoteIsMk() run first.
 *
 * txRun(): several writer calls in ONE transaction (a multi-statement query is one implicit transaction).
 *   dry  → the last statement raises an exception that carries every result: Postgres rolls everything back,
 *          the writers' own validation still runs (exactly what --apply would do, nothing committed);
 *   real → the results come back from the final SELECT and the transaction commits.
 * Every transaction: lock_timeout 2 s, statement_timeout 45 s (the lead's rule for the live database, 02.10.2026).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, MK_REF, mkGuard, assertRemoteIsMk, die } from '../lib/repair-kit.mjs';

export const STOCK_DIR = join(ROOT, 'exports', 'stock');
export const OPENING_AT = '2026-09-22T00:00:00+02:00';
const BG_REF = 'sxymaloycddnoxudxaqp';

let TOKEN = null;
function token() {
  if (TOKEN) return TOKEN;
  let env = '';
  try { env = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* the environment may carry it */ }
  if (env.includes(BG_REF)) die('.env mentions the LIVE BULGARIAN project — refusing.');
  const m = env.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\r\n]*)"?\s*$/m);
  TOKEN = process.env.SUPABASE_ACCESS_TOKEN || (m ? m[1] : null);
  if (!TOKEN) die('SUPABASE_ACCESS_TOKEN missing (.env or the environment).');
  return TOKEN;
}

/** Pinned to Macedonia: config.toml / .env checks, then the +389 fingerprint of the remote. */
export async function guard() {
  mkGuard();
  await assertRemoteIsMk();
}

/** One query against MK; {status, text}. Never prints the token. */
export async function rawQuery(query, { readOnly = false } = {}) {
  if (query.includes(BG_REF)) die('the SQL mentions the LIVE BULGARIAN project — refusing.');
  const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  return { status: res.status, text: text.split(token()).join('***') };
}

/** A read-only SELECT → rows (the read-only role). */
export async function read(query) {
  const { status, text } = await rawQuery(query, { readOnly: true });
  if (status !== 200 && status !== 201) throw new Error(`Management API ${status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : [];
}

/** A SELECT that needs a function the read-only role may not execute (is_business_owner, the stock v2 readers):
 *  run as the owner role inside SET TRANSACTION READ ONLY — Postgres still refuses any write. */
export async function readPriv(query) {
  const { status, text } = await rawQuery(`set transaction read only;
${query}`);
  if (status !== 200 && status !== 201) throw new Error(`Management API ${status}: ${text.slice(0, 600)}`);
  return text ? JSON.parse(text) : [];
}

/** SQL literals */
export const lit = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
export const jlit = (v) => {
  const s = JSON.stringify(v ?? null);
  let tag = 'j';
  while (s.includes(`$${tag}$`)) tag += 'j';
  return `$${tag}$${s}$${tag}$::jsonb`;
};
export const ulit = (v) => {
  if (v !== null && v !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v))) {
    throw new Error(`not a uuid: ${v}`);
  }
  return v ? `'${v}'::uuid` : 'NULL::uuid';
};

/**
 * Run [{k, sql}] (each sql = ONE expression returning jsonb) in one transaction → [{k, v}].
 * dry: rolled back (results carried out by an exception). Throws on any SQL error.
 */
export async function txRun(steps, { dry }) {
  const head = "set local lock_timeout = '2s';\nset local statement_timeout = '45s';\n" +
    'create temp table _stock_s_r (n serial, k text, v jsonb) on commit drop;\n';
  const body = steps.map((s) => `insert into _stock_s_r (k, v) select ${lit(s.k)}, (${s.sql})::jsonb;`).join('\n');
  const agg = "(select coalesce(jsonb_agg(jsonb_build_object('k', k, 'v', v) order by n), '[]'::jsonb) from _stock_s_r)";
  const tail = dry
    ? `do $stock_dry$ begin raise exception 'STOCK_S_DRY:%', ${agg}::text; end $stock_dry$;`
    : `select ${agg} as r;`;
  const { status, text } = await rawQuery(`${head}${body}\n${tail}`);
  if (dry) {
    let msg = text;
    try { msg = JSON.parse(text).message ?? text; } catch { /* keep the text */ }
    const i = msg.indexOf('STOCK_S_DRY:');
    if (i < 0) throw new Error(`dry run failed (rolled back): ${status} ${msg.slice(0, 700)}`);
    let payload = msg.slice(i + 'STOCK_S_DRY:'.length);
    const cut = payload.search(/\n(CONTEXT|DETAIL|HINT):/);
    if (cut >= 0) payload = payload.slice(0, cut);
    return JSON.parse(payload.trim());
  }
  if (status !== 200 && status !== 201) throw new Error(`apply failed (rolled back): ${status} ${text.slice(0, 700)}`);
  const rows = JSON.parse(text);
  const r = rows?.[0]?.r;
  return typeof r === 'string' ? JSON.parse(r) : r;
}

/** The actor of an apply: an auth user who is a business owner. */
export async function ownerActor(actor) {
  const [u] = await readPriv(`select u.id, u.email, public.is_business_owner(u.id) as owner from auth.users u where u.id = ${ulit(actor)}`);
  if (!u) die(`--actor ${actor}: no such auth user.`);
  if (!u.owner) die(`--actor ${u.email}: not an owner (is_business_owner() = false).`);
  return u;
}

/** Any owner — only for a dry run, whose writers still need an actor id (nothing is committed). */
export async function anyOwner() {
  const [u] = await readPriv(`select u.id, u.email from auth.users u where public.is_business_owner(u.id) order by u.created_at limit 1`);
  if (!u) die('no business owner found for the dry run.');
  return u;
}

export function loadJson(dir, name, { optional = false } = {}) {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'));
  } catch (e) {
    if (optional) return null;
    die(`${join(dir, name)}: ${e.message} — run python docs/stock/build_sigma_stock.py first.`);
  }
  return null;
}

export function args(argv, { flags = [], values = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const k = a.slice(2);
    if (flags.includes(k)) out[k] = true;
    else if (values.includes(k)) out[k] = argv[++i];
    else die(`unknown option ${a}`);
  }
  return out;
}
