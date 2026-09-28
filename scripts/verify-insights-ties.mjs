/**
 * verify-insights-ties — READ-ONLY proof that the Insights sale cohort (migration
 * 20260940000000, GET /api/insights/cohort and the Overview's `cohort`) ties out.
 *
 *   node scripts/verify-insights-ties.mjs --from 2026-09-22 --to 2026-09-28
 *   node scripts/verify-insights-ties.mjs --from 2026-09-22 --to 2026-09-28 --json
 *
 *   --from/--to  Skopje calendar days, inclusive (default: the 7 days ending today).
 *                The windows — and the previous period, cut at the elapsed time when
 *                --to is today — come from the SAME helper the api uses
 *                (supabase/functions/api/insightsCommon.ts insightsWindows).
 *   --json       one JSON document on stdout instead of the report
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB unreachable /
 * the migration is not applied.
 *
 * What it proves, for the window (owner rules 2026-09-28, HANDOFF §3):
 *   T1  Σ buckets = total — count, value (денари), COD, and the orders / web / MEX-only parts
 *   T2  Σ by_source = total, and each source's Σ buckets = its total
 *   T3  each source's Σ splits = its total; the header's parts = Σ of the sources' parts
 *   T4  leads: sale + cancelled + trashed + open + other = came in (every source, and the sum)
 *   T5  previous period and spark add up
 *   D1  an independent recount of insights_sale_rows = the payload, and every sale lands in
 *       EXACTLY one bucket: one row per order / web order / MEX-only parcel, no parcel owned twice
 *   D2  the order part of EVERY number (each bucket × each source, outside, splits) = the rows
 *       GET /orders?cohort_bucket&sale_source&sold_from&sold_to lists: the api's own filter
 *       (insightsCommon.ts cohortOrdersFilter), translated to SQL, counted here
 *   D3  the drill links the payload carries point at exactly those lists
 *   D4  the test phones (public.report_excluded_phones: 070 123 456 · 02 312 3123) are in no
 *       sale, lead or cash row — judged by the shared public.is_report_excluded_phone()
 *   D5  cash flow = the MEX register delivered in the window (less the test phones' parcels)
 *   D6  a parcel two orders hold (owner: both accurate) is valued ONCE — the holders' shares
 *       add up to its COD
 *   H   the headline numbers, to compare with docs/handoff/2026-09-28/research-cohort-numbers.md
 *
 * Safety. Pinned to Macedonia: the ref is a constant and the run is refused unless
 * supabase/config.toml agrees and .env does not point at Bulgaria. Every statement passes
 * assertReadOnly() — a single SELECT/WITH, no write keyword or side-effect function outside
 * literals — AND is sent with read_only: true, so Postgres itself refuses a write that slipped
 * past the text check. The access token comes from .env and is never printed.
 *
 * Node: loads the api's TypeScript twin directly (Node ≥ 22.18, or 22.6+ with
 * --experimental-strip-types); otherwise it bundles it with the repo's esbuild (npm ci).
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';            // Macedonia — the ONLY project this script queries
const FORBIDDEN_REF = 'sxymaloycddnoxudxaqp';  // live Bulgaria — never
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const EXIT = { OK: 0, FAIL: 1, ERROR: 2 };
const COHORT_SIG = 'public.insights_cohort(timestamptz,timestamptz,timestamptz,timestamptz,text[],boolean)';
/** research-cohort-numbers.md, 22–28.09.2026 at 28.09 01:40 (before §3's test-phone and
 *  neutral-split rules; 1.337 with the COD > 0 rule). Printed next to the live headline. */
const RESEARCH = { from: '2026-09-22', to: '2026-09-28', count: 1343, value: 3239584, paid: 723, paidValue: 1685032 };

class Refusal extends Error {}
class UsageError extends Error {}

// ── guard (verbatim policy of scripts/verify-attribution.mjs) ──────────────────

let TOKEN = null;
const scrub = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));

function loadToken() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const projectId = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (projectId !== REF) throw new Refusal(`supabase/config.toml project_id = "${projectId}", expected "${REF}" (Macedonia)`);
  let envText = '';
  try { envText = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* fall through to the missing-token refusal */ }
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    if (env[k]?.includes(FORBIDDEN_REF)) throw new Refusal(`.env ${k} points at LIVE BULGARIA — fix the workspace first`);
  }
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Refusal('SUPABASE_ACCESS_TOKEN not found in .env');
  return env.SUPABASE_ACCESS_TOKEN;
}

const WRITE_WORD = new RegExp(String.raw`\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|deallocate|vacuum|analy[sz]e|cluster|reindex|refresh|comment|lock|listen|unlisten|notify|discard|reset|set|begin|commit|rollback|savepoint|release|checkpoint|load|import|security|into)\b`, 'i');
const SIDE_EFFECT_FN = new RegExp(String.raw`\b(nextval|setval|set_config|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_switch_wal|pg_notify|pg_(try_)?advisory_\w+|lo_\w+|dblink\w*|pg_file_\w+|pg_create_\w+|pg_drop_\w+)\s*\(`, 'i');

/** The statement with comments, string literals, quoted identifiers and
 *  dollar-quoted bodies blanked out — what remains is the code Postgres runs. */
function codeOf(sql) {
  let out = '';
  for (let i = 0; i < sql.length;) {
    const c = sql[i];
    const two = sql.slice(i, i + 2);
    if (two === '--') { const j = sql.indexOf('\n', i); i = j < 0 ? sql.length : j; out += ' '; continue; }
    if (two === '/*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) throw new Refusal('refusing SQL: unterminated comment');
      i = j + 2; out += ' '; continue;
    }
    if (c === "'" || c === '"') {
      const backslashes = c === "'" && /(^|\W)[eE]$/.test(out);   // E'...' honours \ escapes
      let j = i + 1;
      for (;; j++) {
        if (j >= sql.length) throw new Refusal('refusing SQL: unterminated literal');
        if (backslashes && sql[j] === '\\') { j++; continue; }
        if (sql[j] === c) { if (sql[j + 1] === c) { j++; continue; } break; }
      }
      out += c + c; i = j + 1; continue;
    }
    const dollar = c === '$' ? sql.slice(i).match(/^\$([A-Za-z_]\w*)?\$/) : null;
    if (dollar) {
      const j = sql.indexOf(dollar[0], i + dollar[0].length);
      if (j < 0) throw new Refusal('refusing SQL: unterminated $-quote');
      out += "''"; i = j + dollar[0].length; continue;
    }
    out += c; i++;
  }
  return out;
}

export function assertReadOnly(sql) {
  const code = codeOf(sql).trim().replace(/;\s*$/, '');
  if (code.includes(';')) throw new Refusal('refusing SQL: more than one statement');
  if (!/^(select|with)\b/i.test(code)) throw new Refusal('refusing SQL: only SELECT / WITH may run');
  const w = code.match(WRITE_WORD);
  if (w) throw new Refusal(`refusing SQL: write keyword "${w[1]}" outside a literal`);
  const f = code.match(SIDE_EFFECT_FN);
  if (f) throw new Refusal(`refusing SQL: side-effect function ${f[1]}()`);
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** One read-only statement against the Macedonian database. */
export async function runSql(query) {
  assertReadOnly(query);
  if (!TOKEN) TOKEN = loadToken();
  for (let attempt = 0; ; attempt++) {
    let res;
    let text;
    try {
      res = await fetch(API, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, read_only: true }),
        signal: AbortSignal.timeout(120_000),
      });
      text = await res.text();
    } catch (e) {
      if (e?.name !== 'TimeoutError' && attempt < 2) { await pause(1500 * (attempt + 1)); continue; }
      throw new Error(`Management API unreachable: ${scrub(e?.message ?? e)}`);
    }
    if ((res.status === 429 || res.status >= 502) && attempt < 2) { await pause(2000 * (attempt + 1)); continue; }
    if (!res.ok) throw new Error(`Management API ${res.status}: ${scrub(text).slice(0, 400)}`);
    return JSON.parse(text);
  }
}

// ── the api's TypeScript twin ─────────────────────────────────────────────────

/** supabase/functions/api/insightsCommon.ts — the SAME windows, sources and /orders
 *  filter the api uses, never a copy. */
export async function loadTwin() {
  const file = join(ROOT, 'supabase', 'functions', 'api', 'insightsCommon.ts');
  try {
    return await import(pathToFileURL(file).href);
  } catch (e) {
    if (e?.code !== 'ERR_UNKNOWN_FILE_EXTENSION' && !/Unknown file extension/i.test(String(e?.message))) throw e;
    let esbuild;
    try { esbuild = await import('esbuild'); } catch {
      throw new UsageError('this Node cannot load TypeScript: use Node >= 22.18 (or 22.6+ with --experimental-strip-types), or run npm ci so esbuild is available');
    }
    const out = await esbuild.build({ entryPoints: [file], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' });
    return import(`data:text/javascript;base64,${Buffer.from(out.outputFiles[0].text).toString('base64')}`);
  }
}

// ── PostgREST filter → SQL (what PostgREST itself would run) ──────────────────

/** The only columns the cohort filter names — anything else is refused, so a
 *  translated filter can never smuggle an identifier into the SQL. */
const PGRST_COLUMNS = new Set([
  'id', 'status', 'price', 'sold_at', 'confirmed_at', 'created_at', 'paid_basis', 'source_type',
  'sale_source', 'sale_source_detail', 'mex_tracking_id', 'mex_status_id', 'mex_cod_mkd',
  'mex_delivered_at', 'customer_phone',
]);
const OPS = { eq: '=', neq: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' };

function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (depth < 0) throw new Error(`unbalanced filter: ${s}`);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (depth !== 0) throw new Error(`unbalanced filter: ${s}`);
  if (cur) out.push(cur);
  return out;
}
const quote = (v) => `'${String(v).replace(/'/g, "''")}'`;

/** One PostgREST logic term (`and(…)`, `not.or(…)`, `col.op.value`) → SQL. */
export function pgrstTermToSql(term, alias = 'o') {
  const t = term.trim();
  const logic = t.match(/^(not\.)?(and|or)\((.*)\)$/s);
  if (logic) {
    const parts = splitTop(logic[3]).map((p) => pgrstTermToSql(p, alias));
    const body = `(${parts.join(logic[2] === 'and' ? ' AND ' : ' OR ')})`;
    return logic[1] ? `(NOT ${body})` : body;
  }
  const m = t.match(/^([a-z_][a-z0-9_]*)\.(not\.)?(eq|neq|gt|gte|lt|lte|is|in|like)\.(.*)$/s);
  if (!m) throw new Error(`cannot translate PostgREST term: ${t}`);
  const [, col, neg, op, val] = m;
  if (!PGRST_COLUMNS.has(col)) throw new Error(`column not allowed in a translated filter: ${col}`);
  const c = `${alias}.${col}`;
  let expr;
  if (op === 'is') {
    if (!['null', 'true', 'false'].includes(val)) throw new Error(`bad is. value: ${val}`);
    expr = `${c} IS ${val.toUpperCase()}`;
  } else if (op === 'in') {
    const inner = val.match(/^\((.*)\)$/s);
    if (!inner) throw new Error(`bad in. list: ${val}`);
    const items = inner[1] === '' ? [] : inner[1].split(',');
    expr = items.length ? `${c}::text IN (${items.map(quote).join(', ')})` : 'false';
  } else if (op === 'like') {
    expr = `${c} LIKE ${quote(val.replace(/\*/g, '%'))}`;
  } else {
    expr = `${c} ${OPS[op]} ${quote(val)}`;
  }
  return neg ? `(NOT (${expr}))` : `(${expr})`;
}

/** A supabase-js `.or(expr)` (PostgREST `or=(expr)`) → SQL. */
export const pgrstOrToSql = (expr, alias = 'o') => pgrstTermToSql(`or(${expr})`, alias);

/** What GET /orders?cohort_bucket=<keys>&sale_source=<ss>&sale_source_detail=<d>&sold_from&sold_to
 *  selects, as SQL predicates over public.orders <alias> (ANDed) — built from the api's
 *  own cohortOrdersFilter() plus the plain column filters the handler adds. */
export function drillPredicateParts(IC, { keys, saleSources = [], detail = null, window = null, ex }, alias = 'o') {
  const f = IC.cohortOrdersFilter(keys, ex, window);
  const parts = f.or.map((e) => pgrstOrToSql(e, alias));
  if (saleSources.length) parts.push(`${alias}.sale_source IN (${saleSources.map(quote).join(', ')})`);
  if (detail) parts.push(`${alias}.sale_source_detail = ${quote(detail)}`);
  if (f.notIds.length) parts.push(`${alias}.id::text NOT IN (${f.notIds.map(quote).join(', ')})`);
  return parts;
}
export const drillPredicateSql = (IC, opts, alias = 'o') => drillPredicateParts(IC, opts, alias).join('\n  AND ');

/** A payload drill link → its params (null when there is none). */
export function parseDrill(href) {
  if (typeof href !== 'string' || !href) return null;
  const q = href.indexOf('?');
  if (!href.startsWith('/orders?') || q < 0) return { bad: href };
  const sp = new URLSearchParams(href.slice(q + 1));
  return {
    cohort_bucket: sp.get('cohort_bucket'),
    sale_source: sp.get('sale_source'),
    sale_source_detail: sp.get('sale_source_detail'),
    sold_from: sp.get('sold_from'),
    sold_to: sp.get('sold_to'),
  };
}

// ── pure ties over the payload ────────────────────────────────────────────────

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const PART_FIELDS = ['count', 'value_mkd', 'cod_mkd', 'orders', 'web', 'mex_only'];

function sumBy(list, field) { return (list ?? []).reduce((a, x) => a + n(x?.[field]), 0); }

/** A tie line: label, expected, got, ok. */
const tie = (label, want, got) => ({ label, want, got, ok: want === got });

/** T1–T5: everything the payload promises about itself. Each returns tie lines. */
export function payloadTies(c) {
  const out = { T1: [], T2: [], T3: [], T4: [], T5: [] };
  const total = c.total ?? {};
  // T1 Σ buckets = total
  for (const f of PART_FIELDS) {
    if (total[f] === undefined) continue;
    out.T1.push(tie(`Σ buckets.${f} = total.${f}`, n(total[f]), sumBy(c.buckets, f)));
  }
  // T2 Σ by_source = total; each source's Σ buckets = its total
  for (const f of PART_FIELDS) {
    if (total[f] === undefined) continue;
    out.T2.push(tie(`Σ by_source.total.${f} = total.${f}`, n(total[f]), (c.by_source ?? []).reduce((a, r) => a + n(r.total?.[f]), 0)));
  }
  for (const r of c.by_source ?? []) {
    for (const f of ['count', 'value_mkd', 'cod_mkd']) {
      if (r.total?.[f] === undefined) continue;
      out.T2.push(tie(`${r.key}: Σ buckets.${f} = total.${f}`, n(r.total[f]), sumBy(r.buckets, f)));
    }
  }
  // T3 splits = the source's total; the header's parts = Σ sources' parts
  for (const r of c.by_source ?? []) {
    for (const f of ['count', 'value_mkd']) {
      if (r.total?.[f] === undefined) continue;
      out.T3.push(tie(`${r.key}: Σ splits.${f} = total.${f}`, n(r.total[f]), sumBy(r.splits, f)));
    }
  }
  for (const list of ['buckets', 'outside']) {
    for (const b of c[list] ?? []) {
      for (const f of ['count', 'value_mkd']) {
        if (b[f] === undefined) continue;
        const s = (c.by_source ?? []).reduce((a, r) => a + n((r[list] ?? []).find((x) => x.key === b.key)?.[f]), 0);
        out.T3.push(tie(`${list} ${b.key}.${f} = Σ sources`, n(b[f]), s));
      }
    }
  }
  // T4 leads partition, per source and summed
  const leadsOk = (label, l) => tie(`${label}: sale+cancelled+trashed+open+other = came_in`, n(l?.came_in),
    n(l?.became_sales) + n(l?.cancelled) + n(l?.trashed) + n(l?.open) + n(l?.other));
  out.T4.push(leadsOk('all', c.leads_in));
  for (const r of c.by_source ?? []) out.T4.push(leadsOk(r.key, r.leads_in));
  for (const f of ['came_in', 'became_sales', 'cancelled', 'trashed', 'open', 'other', 'disposition']) {
    out.T4.push(tie(`Σ by_source.leads_in.${f} = leads_in.${f}`, n(c.leads_in?.[f]),
      (c.by_source ?? []).reduce((a, r) => a + n(r.leads_in?.[f]), 0)));
  }
  // T5 prev and spark
  if (c.prev) {
    for (const f of ['count', 'value_mkd']) {
      if (c.prev.total?.[f] === undefined) continue;
      out.T5.push(tie(`prev: Σ buckets.${f} = total.${f}`, n(c.prev.total[f]), sumBy(c.prev.buckets, f)));
    }
  }
  if (c.meta?.granularity === 'day' && Array.isArray(c.spark)) {
    const inWin = c.spark.filter((p) => p.d >= c.meta.from && p.d <= c.meta.to);
    out.T5.push(tie('spark: Σ days in the window = total.count', n(total.count), sumBy(inWin, 'count')));
    if (total.value_mkd !== undefined) out.T5.push(tie('spark: Σ days in the window = total.value_mkd', n(total.value_mkd), sumBy(inWin, 'value_mkd')));
  }
  return out;
}

// ── checks against the database ──────────────────────────────────────────────

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3,6})?Z$/;
const tsLit = (iso) => { if (!ISO_RE.test(iso)) throw new Error(`bad instant ${iso}`); return `'${iso}'::timestamptz`; };
const statusOf = (lines) => (lines.every((l) => l.ok) ? 'PASS' : 'FAIL');
const IN_BUCKETS = ['paid', 'paid_unproven', 'paid_legacy', 'courier', 'courier_problem', 'label', 'to_pack', 'returned'];

async function probe(ctx) {
  const [r] = await ctx.sql(`
SELECT to_regprocedure('${COHORT_SIG}') IS NOT NULL AS has_cohort,
  coalesce(has_function_privilege(to_regprocedure('${COHORT_SIG}'), 'execute'), false) AS can_cohort,
  to_regprocedure('public.insights_sale_rows(timestamptz,timestamptz,boolean)') IS NOT NULL AS has_rows,
  to_regprocedure('public.insights_cohort_order_exceptions(timestamptz,timestamptz)') IS NOT NULL AS has_ex,
  to_regprocedure('public.is_report_excluded_phone(text)') IS NOT NULL
    AND to_regprocedure('public.report_excluded_phone8s()') IS NOT NULL AS has_xp`);
  if (!r.has_xp) {
    throw new UsageError('migration 20260939000700_report_excluded_phones is not applied (is_report_excluded_phone / report_excluded_phone8s missing)');
  }
  if (!r.has_cohort || !r.has_rows || !r.has_ex) {
    throw new UsageError('migration 20260940000000_insights_foundation is not applied (insights_cohort / insights_sale_rows / insights_cohort_order_exceptions missing)');
  }
  if (!r.can_cohort) throw new UsageError('the read-only role cannot EXECUTE insights_cohort — re-run the grants at the end of migration 20260940000000');
}

/** D1: recount the rows the payload was built from; one row per sale, one bucket per row. */
async function d1Recount(ctx) {
  const { w, cohort } = ctx;
  const [r] = await ctx.sql(`
WITH r AS (SELECT * FROM public.insights_sale_rows(${tsLit(w.fromIso)}, ${tsLit(w.toEndIso)}, false))
SELECT count(*) FILTER (WHERE in_total)::int AS n,
  coalesce(sum(value_mkd) FILTER (WHERE in_total), 0) AS v,
  coalesce(sum(cod_mkd) FILTER (WHERE in_total), 0) AS c,
  count(*)::int AS all_rows,
  count(*) FILTER (WHERE bucket IS NULL OR bucket NOT IN (${[...IN_BUCKETS, 'cancelled_after_sale', 'trashed_after_sale', 'replacement'].map(quote).join(', ')}))::int AS bad_bucket,
  count(*) FILTER (WHERE in_total IS DISTINCT FROM (bucket IN (${IN_BUCKETS.map(quote).join(', ')}))) ::int AS bad_in_total,
  (count(*) - count(DISTINCT CASE kind WHEN 'order' THEN 'o:' || order_id::text
                                     WHEN 'web' THEN 'w:' || web_id::text
                                     ELSE 'm:' || tracking_id END))::int AS dup_rows,
  (SELECT count(*) FROM (SELECT tracking_id FROM r WHERE tracking_id IS NOT NULL
                         GROUP BY tracking_id HAVING count(DISTINCT kind) > 1
                            OR count(*) FILTER (WHERE kind <> 'order') > 1) d)::int AS parcel_twice,
  (SELECT coalesce(json_agg(x ORDER BY x.bucket), '[]') FROM (
     SELECT bucket, count(*)::int AS n, coalesce(sum(value_mkd), 0) AS v FROM r GROUP BY bucket) x) AS by_bucket
FROM r`);
  const lines = [
    tie('rows in the total = payload total.count', n(cohort.total?.count), n(r.n)),
    tie('Σ value_mkd of those rows = payload total.value_mkd', n(cohort.total?.value_mkd), n(r.v)),
    tie('Σ cod_mkd of those rows = payload total.cod_mkd', n(cohort.total?.cod_mkd), n(r.c)),
    tie('rows without a known bucket', 0, r.bad_bucket),
    tie('rows whose in_total disagrees with their bucket', 0, r.bad_in_total),
    tie('a sale on more than one row (order / web order / parcel)', 0, r.dup_rows),
    tie('a parcel owned twice (order+web, order+MEX-only, …; shared-by-two-orders excepted)', 0, r.parcel_twice),
  ];
  for (const b of r.by_bucket) {
    const pb = [...(cohort.buckets ?? []), ...(cohort.outside ?? [])].find((x) => x.key === b.bucket);
    lines.push(tie(`bucket ${b.bucket}: rows = payload count`, n(pb?.count), b.n));
  }
  return { status: statusOf(lines), lines, note: `${r.all_rows} sale rows (incl. outside the total) in the window` };
}

/** D2 + D3: every order part = what GET /orders lists; every drill link = that list. */
async function d2Drills(ctx) {
  const { IC, cohort, w, ex } = ctx;
  const window = { fromIso: w.fromIso, toEndIso: w.toEndIso };
  const scopes = [{ key: '*', ss: [] }, ...(cohort.by_source ?? []).map((r) => ({ key: r.key, ss: IC.SOURCE_SALE_SOURCES[r.key] ?? [] }))];
  const partsOf = (scope) => {
    const row = scope.key === '*' ? cohort : (cohort.by_source ?? []).find((r) => r.key === scope.key);
    return [
      { key: 'total', keys: ['total'], orders: n(row?.total?.orders), drill: row?.total?.drill },
      ...(row?.buckets ?? []).map((b) => ({ key: b.key, keys: [b.key], orders: n(b.orders), drill: b.drill })),
      ...(row?.outside ?? []).map((b) => ({ key: b.key, keys: [b.key], orders: n(b.orders), drill: b.drill })),
    ];
  };
  const probes = [];
  for (const s of scopes) {
    for (const p of partsOf(s)) probes.push({ label: `${s.key} · ${p.key}`, scope: s, keys: p.keys, want: p.orders, drill: p.drill, detail: null });
    if (s.key !== '*') {
      const row = (cohort.by_source ?? []).find((r) => r.key === s.key);
      for (const sp of row?.splits ?? []) {
        if (sp.kind !== 'order' || !sp.drill) continue;
        probes.push({ label: `${s.key} · split ${sp.key}`, scope: s, keys: ['total'], want: n(sp.count), drill: sp.drill, detail: sp.key });
      }
    }
  }
  const preds = probes.map((p) => {
    const keys = IC.parseCohortBucketParam(p.keys.join(','));
    if (!keys.ok) throw new Error(`bad bucket ${p.keys}`);
    return drillPredicateParts(IC, { keys: keys.values, saleSources: p.scope.ss, detail: p.detail, window, ex });
  });
  // What every list shares (universe, test phones, the window) is filtered once.
  const common = preds[0].filter((x) => preds.every((ps) => ps.includes(x)));
  const cols = preds.map((ps, i) => {
    const rest = ps.filter((x) => !common.includes(x));
    return `count(*) FILTER (WHERE ${rest.length ? rest.join(' AND ') : 'true'})::int AS p${i}`;
  });
  const [r] = await ctx.sql(`SELECT ${cols.join(',\n  ')}\nFROM public.orders o\nWHERE ${common.length ? common.join('\n  AND ') : 'true'}`);
  const lines = [];
  const linkLines = [];
  probes.forEach((p, i) => {
    lines.push(tie(`${p.label}: /orders lists = the order part`, p.want, r[`p${i}`]));
    // D3: the link the payload carries
    const d = parseDrill(p.drill);
    if (p.want === 0) { linkLines.push(tie(`${p.label}: no link when there are no orders`, 'none', d ? 'link' : 'none')); return; }
    const wantSs = p.scope.key === '*' ? null : (p.scope.ss.join(',') || null);
    const wantBucket = p.keys[0];
    const got = d ? `${d.cohort_bucket}|${d.sale_source}|${d.sale_source_detail}|${d.sold_from}|${d.sold_to}` : 'none';
    linkLines.push(tie(`${p.label}: link`, `${wantBucket}|${wantSs}|${p.detail}|${cohort.meta.from}|${cohort.meta.to}`, got));
  });
  return { status: statusOf([...lines, ...linkLines]), lines, linkLines };
}

/** The owner's test phones (HANDOFF §3, 2026-09-28) — D4 checks the shared list still
 *  holds them. The cohort itself never reads this: its list is the database's. */
const OWNER_TEST_PHONE8 = ['70123456', '23123123'];

/** D4: the test phones are nowhere — judged by the shared helper every report uses,
 *  public.is_report_excluded_phone() (migration 20260939000700), not by the cohort's
 *  own set-based test. */
async function d4TestPhones(ctx) {
  const { w, ex } = ctx;
  // the set-based form 20260939000700 recommends for a scan (one InitPlan)
  const tp = '((SELECT public.report_excluded_phone8s())::text[])';
  const p8 = (col) => `right(regexp_replace(${col}, '[^0-9]', '', 'g'), 8)`;
  const f = tsLit(w.fromIso);
  const t = tsLit(w.toEndIso);
  const [r] = await ctx.sql(`
SELECT
  (SELECT to_json(public.report_excluded_phone8s())) AS sql_list,
  (SELECT count(*) FROM public.insights_sale_rows(${f}, ${t}, false) s
     LEFT JOIN public.orders o ON o.id = s.order_id
    WHERE public.is_report_excluded_phone(s.phone8) OR public.is_report_excluded_phone(o.customer_phone))::int AS sale_rows,
  (SELECT count(*) FROM public.insights_sale_rows(${f}, ${t}, false) s
     JOIN public.mex_parcels p ON p.tracking_id = s.tracking_id WHERE public.is_report_excluded_phone(p.phone8))::int AS sale_parcels,
  (SELECT count(*) FROM public.insights_leads_rows(${f}, ${t}) l
     LEFT JOIN public.orders o ON o.id = l.order_id
     LEFT JOIN public.web_orders wo ON wo.shop_order_id = l.web_id
    WHERE public.is_report_excluded_phone(o.customer_phone) OR public.is_report_excluded_phone(wo.phone8))::int AS lead_rows,
  (SELECT count(*) FROM public.insights_cash_rows(${f}, ${t}) c
     JOIN public.mex_parcels p ON p.tracking_id = c.tracking_id WHERE public.is_report_excluded_phone(p.phone8))::int AS cash_rows,
  (SELECT count(*) FROM public.orders o WHERE ${p8('o.customer_phone')} = ANY ${tp}
      AND (o.created_at BETWEEN ${f} AND ${t} OR o.sold_at BETWEEN ${f} AND ${t}))::int AS crm_orders_there,
  (SELECT count(*) FROM public.web_orders wo WHERE wo.deleted_in_shop_at IS NULL AND wo.phone8 = ANY ${tp}
      AND wo.created_at BETWEEN ${f} AND ${t})::int AS web_orders_there,
  (SELECT count(*) FROM public.mex_parcels p WHERE p.phone8 = ANY ${tp}
      AND (p.created_at_mex BETWEEN ${f} AND ${t} OR p.delivered_at BETWEEN ${f} AND ${t}))::int AS parcels_there`);
  const list = (typeof r.sql_list === 'string' ? JSON.parse(r.sql_list) : r.sql_list) ?? [];
  const lines = [
    tie("the owner's test phones are on public.report_excluded_phones",
      OWNER_TEST_PHONE8.join(','), OWNER_TEST_PHONE8.filter((x) => list.includes(x)).join(',')),
    tie('the /orders twin got the same list (exceptions.excluded_phone8s)',
      [...list].sort().join(',') || '(none)', [...ex.excluded_phone8s].sort().join(',') || '(none)'),
    tie('sale rows on a test phone', 0, r.sale_rows),
    tie('sale rows holding a test-phone parcel', 0, r.sale_parcels),
    tie('lead rows on a test phone', 0, r.lead_rows),
    tie('cash rows of a test-phone parcel', 0, r.cash_rows),
  ];
  return {
    status: statusOf(lines), lines,
    note: `list ${list.join(' · ') || '(empty)'}; excluded in the window: ${r.crm_orders_there} CRM orders, ${r.web_orders_there} web orders, ${r.parcels_there} MEX parcels on those phones`,
  };
}

/** D5: cash flow = the MEX register. */
async function d5Cash(ctx) {
  const { w, cohort } = ctx;
  const f = tsLit(w.fromIso);
  const t = tsLit(w.toEndIso);
  const [r] = await ctx.sql(`
WITH reg AS (        -- the register, less the test phones' parcels (the shared helper)
  SELECT p.tracking_id, p.cod_mkd, p.order_id FROM public.mex_parcels p
  WHERE p.delivered_at BETWEEN ${f} AND ${t} AND NOT public.is_report_excluded_phone(p.phone8)
), test_owned AS (   -- the second documented exclusion: the parcel's owner is a test order / test web order
  SELECT reg.tracking_id, reg.cod_mkd FROM reg
  LEFT JOIN LATERAL (    -- the owner when a live web order claims it: the latest claim
    SELECT true AS hit, public.is_report_excluded_phone(w.phone8) AS test FROM public.web_orders w
    WHERE w.mex_tracking_id = reg.tracking_id AND w.deleted_in_shop_at IS NULL
    ORDER BY w.created_at DESC, w.shop_order_id DESC LIMIT 1) wc ON true
  WHERE CASE
    WHEN wc.hit THEN wc.test
    WHEN EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = reg.tracking_id
                   AND o.sale_source_detail IS DISTINCT FROM 'disposition')
      THEN NOT EXISTS (SELECT 1 FROM public.orders o WHERE o.mex_tracking_id = reg.tracking_id
                   AND o.sale_source_detail IS DISTINCT FROM 'disposition' AND NOT public.is_report_excluded_phone(o.customer_phone))
    ELSE coalesce((SELECT public.is_report_excluded_phone(o.customer_phone) FROM public.orders o
                   WHERE o.id = reg.order_id AND o.sale_source_detail IS DISTINCT FROM 'disposition'), false)
  END
), c AS (SELECT * FROM public.insights_cash_rows(${f}, ${t}))
SELECT (SELECT count(*) FROM reg)::int AS reg_n, (SELECT coalesce(sum(cod_mkd), 0) FROM reg) AS reg_cod,
  (SELECT count(*) FROM test_owned)::int AS test_n, (SELECT coalesce(sum(cod_mkd), 0) FROM test_owned) AS test_cod,
  (SELECT count(*) FROM c)::int AS cash_n, (SELECT coalesce(sum(cod_mkd), 0) FROM c) AS cash_cod,
  (SELECT coalesce(sum(card_mkd), 0) FROM c) AS card,
  (SELECT coalesce(json_agg(x ORDER BY x.source, x.split), '[]') FROM (
     SELECT source, split, count(*)::int AS n, coalesce(sum(cod_mkd), 0) AS cod FROM c GROUP BY 1, 2) x) AS by_split`);
  const cf = cohort.cash_flow ?? {};
  const lines = [
    tie('cash rows = register parcels delivered in the window (less test phones and test-held)', r.reg_n - r.test_n, r.cash_n),
    tie('Σ cash COD = Σ register COD (same exclusions)', n(r.reg_cod) - n(r.test_cod), n(r.cash_cod)),
    tie('payload cash_flow.parcels = cash rows', r.cash_n, n(cf.parcels)),
  ];
  if (cf.cod_mkd !== undefined) {
    lines.push(tie('payload cash_flow.cod_mkd = Σ cash COD', Math.round(n(r.cash_cod)), n(cf.cod_mkd)));
    lines.push(tie('from this period + from earlier = COD + card', Math.round(n(r.cash_cod) + n(r.card)),
      n(cf.from_this_period_mkd) + n(cf.from_earlier_mkd)));
  }
  return {
    status: statusOf(lines), lines, bySplit: r.by_split,
    note: `register parcels delivered in the window, less the test phones' own parcels and ${r.test_n} held only by a test order / test web order`,
  };
}

/** D6: a parcel two orders hold is valued once. */
async function d6Shared(ctx) {
  const rows = await ctx.sql(`
WITH h AS (
  SELECT o.mex_tracking_id AS tr, count(*)::int AS holders,
         min(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS lo,
         max(coalesce(o.sold_at, o.confirmed_at, o.created_at)) AS hi
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND o.sale_source_detail IS DISTINCT FROM 'disposition'
  GROUP BY o.mex_tracking_id
  HAVING count(*) > 1
)
SELECT h.tr, h.holders, p.cod_mkd, p.status_id, to_char(h.lo, 'YYYY-MM-DD') AS lo, to_char(h.hi, 'YYYY-MM-DD') AS hi
FROM h LEFT JOIN public.mex_parcels p ON p.tracking_id = h.tr
ORDER BY h.tr`);
  if (!rows.length) return { status: 'PASS', lines: [], note: 'no tracking id is held by two orders' };
  const lo = rows.reduce((a, r) => (r.lo < a ? r.lo : a), rows[0].lo);
  const hi = rows.reduce((a, r) => (r.hi > a ? r.hi : a), rows[0].hi);
  const days = (Date.parse(`${hi}T00:00:00Z`) - Date.parse(`${lo}T00:00:00Z`)) / 86_400_000;
  if (days > 790) return { status: 'WARN', lines: [], note: `shared parcels span ${lo}..${hi} — too long for one insights_sale_rows call` };
  // the whole span, a day of slack each side (the ledger date can move a sale day)
  const from = new Date(Date.parse(`${lo}T00:00:00Z`) - 2 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const to = new Date(Date.parse(`${hi}T00:00:00Z`) + 3 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, '.000Z');
  const got = await ctx.sql(`
SELECT s.tracking_id AS tr, count(*)::int AS rows, coalesce(sum(s.value_mkd), 0) AS v, coalesce(sum(s.cod_mkd), 0) AS c,
       bool_and(s.q_shared_parcel) AS flagged
FROM public.insights_sale_rows(${tsLit(from)}, ${tsLit(to)}, false) s
WHERE s.kind = 'order' AND s.tracking_id IN (${rows.map((r) => quote(r.tr)).join(', ')})
GROUP BY s.tracking_id`);
  const lines = [];
  for (const r of rows) {
    const g = got.find((x) => x.tr === r.tr);
    if (!g) { lines.push({ label: `${r.tr}: no holder is a sale (web-claimed, test or not moving yet)`, want: '-', got: '-', ok: true }); continue; }
    if (n(r.cod_mkd) > 0 && g.rows === r.holders) {
      lines.push(tie(`${r.tr}: Σ holders' value = its COD (${g.rows} holders)`, n(r.cod_mkd), n(g.v)));
      lines.push(tie(`${r.tr}: Σ holders' cod_mkd = its COD`, n(r.cod_mkd), n(g.c)));
      lines.push(tie(`${r.tr}: flagged q_shared_parcel`, true, Boolean(g.flagged)));
    } else {
      lines.push({ label: `${r.tr}: ${g.rows} of ${r.holders} holders are sales (COD ${r.cod_mkd})`, want: '-', got: n(g.v), ok: n(g.v) <= Math.max(n(r.cod_mkd), 0) || n(r.cod_mkd) <= 0 });
    }
  }
  return { status: statusOf(lines), lines, note: `${rows.length} tracking ids held by two or more orders (owner: both accurate — the COD is split, not doubled)` };
}

// ── report ──────────────────────────────────────────────────────────────────

const fmt = (x) => (x == null ? '-' : Number.isFinite(Number(x)) ? Number(x).toLocaleString('de-DE') : String(x));

export function headline(c) {
  const out = [];
  const money = c.meta?.money !== false;
  const part = (b) => `${fmt(b.count)}${money && b.value_mkd !== undefined ? ` · ${fmt(b.value_mkd)} ден` : ''}`;
  out.push(`SALES ${c.meta.from} .. ${c.meta.to} (sale day, Skopje): ${part(c.total)}${c.total.cod_mkd !== undefined ? ` (COD of the parcels ${fmt(c.total.cod_mkd)})` : ''}`);
  out.push(`  of which orders ${fmt(c.total.orders)} · web orders ${fmt(c.total.web)} · MEX-only parcels ${fmt(c.total.mex_only)}`);
  for (const b of c.buckets ?? []) out.push(`  ${b.key.padEnd(16)} ${part(b)}   (orders ${fmt(b.orders)} · web ${fmt(b.web)} · MEX-only ${fmt(b.mex_only)})`);
  out.push('  outside the total:');
  for (const b of c.outside ?? []) out.push(`  ${b.key.padEnd(20)} ${part(b)}`);
  out.push('BY SOURCE');
  for (const r of c.by_source ?? []) {
    out.push(`  ${r.key.padEnd(15)} ${part(r.total)}`);
    for (const s of r.splits ?? []) out.push(`      ${String(s.key).padEnd(16)} ${String(s.kind).padEnd(5)} ${part(s)}`);
    const l = r.leads_in ?? {};
    out.push(`      leads: came in ${fmt(l.came_in)} → sales ${fmt(l.became_sales)} · cancelled ${fmt(l.cancelled)} · trashed ${fmt(l.trashed)} · open ${fmt(l.open)} · other ${fmt(l.other)} (of which "no" calls ${fmt(l.disposition)})`);
  }
  const cf = c.cash_flow ?? {};
  out.push(`CASH (MEX delivered in the window, any sale day): ${fmt(cf.parcels)} parcels${money ? ` · COD ${fmt(cf.cod_mkd)} ден + card ${fmt(cf.card_mkd)} ден (from this period ${fmt(cf.from_this_period_mkd)} · earlier ${fmt(cf.from_earlier_mkd)})` : ''}`);
  out.push(`QUALITY ${(c.quality ?? []).map((q) => `${q.kind} ${fmt(q.count)}`).join(' · ')}`);
  if (c.prev) out.push(`PREV ${c.meta.prev_from} .. ${c.meta.prev_to}: ${part(c.prev.total)}`);
  if (c.meta.from === RESEARCH.from && c.meta.to === RESEARCH.to) {
    out.push(`RESEARCH (28.09 01:40, before the §3 rules): ${fmt(RESEARCH.count)} · ${fmt(RESEARCH.value)} ден, paid ${fmt(RESEARCH.paid)} · ${fmt(RESEARCH.paidValue)} ден`);
  }
  return out;
}

export function printText(ctx, results, exitCode) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (s) => (color ? `\x1b[${{ PASS: 32, FAIL: 31, WARN: 33 }[s] ?? 90}m${s.padEnd(5)}\x1b[0m` : s.padEnd(5));
  const out = [];
  out.push(`verify-insights-ties | Macedonia ${REF} | read-only | window ${ctx.w.from} .. ${ctx.w.to} Skopje = [${ctx.w.fromIso}, ${ctx.w.toEndIso}]${ctx.w.partial ? ' (today: partial)' : ''}`);
  out.push('');
  for (const r of results) out.push(`${r.id.padEnd(4)} ${paint(r.status)} ${r.title}`);
  out.push('');
  out.push(...headline(ctx.cohort));
  for (const r of results) {
    const bad = (r.lines ?? []).filter((l) => !l.ok);
    const badLinks = (r.linkLines ?? []).filter((l) => !l.ok);
    out.push('', `[${r.id}] ${r.title} — ${r.status}${r.note ? ` · ${r.note}` : ''}`);
    const show = r.status === 'PASS' ? [] : [...bad, ...badLinks];
    for (const l of show.slice(0, 40)) out.push(`    ✗ ${l.label}: want ${fmt(l.want)} got ${fmt(l.got)}`);
    if (show.length > 40) out.push(`    … ${show.length - 40} more`);
    if (r.status === 'PASS') out.push(`    ${(r.lines ?? []).length + (r.linkLines ?? []).length} ties hold`);
    if (r.bySplit) out.push(`    cash by source/split: ${r.bySplit.map((x) => `${x.source}/${x.split} ${fmt(x.n)} · ${fmt(x.cod)}`).join(' | ')}`);
  }
  out.push('', `exit ${exitCode}`);
  console.log(out.join('\n'));
}

// ── arguments + main ──────────────────────────────────────────────────────────

const USAGE = `usage: node scripts/verify-insights-ties.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--json]
Read-only. Dates are Skopje calendar days (inclusive; default the 7 days ending today).
Exit 1 if any tie FAILs, 2 if refused / unreachable / the migration is not applied.`;

export function parseArgs(argv) {
  const opts = { json: false, from: null, to: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === '--json' && val === undefined) opts.json = true;
    else if ((arg === '--help' || arg === '-h') && val === undefined) opts.help = true;
    else if (arg === '--from' || arg === '--to') {
      if (val === undefined) val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[arg.slice(2)] = val;
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  for (const k of ['from', 'to']) {
    if (opts[k] != null && !/^\d{4}-\d{2}-\d{2}$/.test(opts[k])) throw new UsageError(`--${k} must be YYYY-MM-DD, got "${opts[k]}"`);
  }
  return opts;
}

/** Everything but the transport: `sql(query) → rows`. The sandbox harness calls this too. */
export async function verify({ from, to, sql, now = new Date(), IC: twin = null }) {
  const IC = twin ?? await loadTwin();
  const toDay = to ?? IC.insightsWindows(null, null, false, now).to;
  const fromDay = from ?? new Date(Date.parse(`${toDay}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
  const w = IC.insightsWindows(fromDay, toDay, true, now);
  if ('error' in w) throw new UsageError(w.error);
  const ctx = { sql, IC, w };
  await probe(ctx);
  const [c] = await sql(`SELECT public.insights_cohort(${tsLit(w.fromIso)}, ${tsLit(w.toEndIso)}, ${tsLit(w.prev.fromIso)}, ${tsLit(w.prev.toEndIso)}, NULL::text[], true) AS cohort`);
  ctx.cohort = typeof c.cohort === 'string' ? JSON.parse(c.cohort) : c.cohort;
  const [e] = await sql(`SELECT public.insights_cohort_order_exceptions(${tsLit(w.fromIso)}, ${tsLit(w.toEndIso)}) AS ex`);
  ctx.ex = IC.parseCohortExceptions(typeof e.ex === 'string' ? JSON.parse(e.ex) : e.ex);
  if (!ctx.ex) throw new Error('insights_cohort_order_exceptions() returned an unusable payload (malformed, or more ids than a URL can carry)');

  const ties = payloadTies(ctx.cohort);
  const results = [
    { id: 'T1', title: 'Σ buckets = total (count, денари, COD, orders/web/MEX-only)', status: statusOf(ties.T1), lines: ties.T1 },
    { id: 'T2', title: 'Σ by_source = total; each source Σ buckets = its total', status: statusOf(ties.T2), lines: ties.T2 },
    { id: 'T3', title: 'each source Σ splits = its total; header parts = Σ sources', status: statusOf(ties.T3), lines: ties.T3 },
    { id: 'T4', title: 'leads: sale + cancelled + trashed + open + other = came in', status: statusOf(ties.T4), lines: ties.T4 },
    { id: 'T5', title: 'previous period and spark add up', status: statusOf(ties.T5), lines: ties.T5 },
  ];
  const run = async (id, title, fn) => {
    try { results.push({ id, title, ...(await fn(ctx)) }); } catch (err) {
      if (err instanceof Refusal) throw err;
      results.push({ id, title, status: 'FAIL', lines: [], note: `could not run: ${scrub(err?.message ?? err)}` });
    }
  };
  await run('D1', 'independent recount; one row per sale, one bucket per row', d1Recount);
  await run('D2', 'the order part of every number = what /orders lists (and its link)', d2Drills);
  await run('D4', 'test phones in no sale, lead or cash row', d4TestPhones);
  await run('D5', 'cash flow = the MEX register delivered in the window', d5Cash);
  await run('D6', 'a parcel two orders hold is valued once', d6Shared);
  return { ctx, results };
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return EXIT.OK; }
  TOKEN = loadToken();
  const { ctx, results } = await verify({ from: opts.from, to: opts.to, sql: runSql });
  const fail = results.some((r) => r.status === 'FAIL');
  const exitCode = fail ? EXIT.FAIL : EXIT.OK;
  if (opts.json) {
    console.log(JSON.stringify({
      tool: 'verify-insights-ties', ref: REF, read_only: true, generated_at: new Date().toISOString(),
      window: ctx.w, exit_code: exitCode, headline: headline(ctx.cohort), results, cohort: ctx.cohort,
    }, null, 2));
  } else {
    printText(ctx, results, exitCode);
  }
  return exitCode;
}

function invokedAsCli() {
  if (!process.argv[1]) return false;
  const norm = (p) => {
    let real = p;
    try { real = realpathSync(p); } catch { /* keep as given */ }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  return norm(resolve(process.argv[1])) === norm(fileURLToPath(import.meta.url));
}

if (invokedAsCli()) {
  const argv = process.argv.slice(2);
  main(argv).then((code) => { process.exitCode = code; }, (e) => {
    const kind = e instanceof Refusal ? 'REFUSED' : e instanceof UsageError ? 'usage' : 'error';
    const msg = scrub(e?.message ?? e);
    if (argv.includes('--json')) console.log(JSON.stringify({ tool: 'verify-insights-ties', ok: false, kind, error: msg }));
    console.error(`verify-insights-ties ${kind}: ${msg}${e instanceof UsageError ? `\n${USAGE}` : ''}`);
    process.exitCode = EXIT.ERROR;
  });
}
