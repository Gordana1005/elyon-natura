#!/usr/bin/env node
/**
 * verify-attribution — READ-ONLY proof that the money is attributed correctly
 * and that every "paid" is backed by the courier (MEX Poshta).
 *
 *   node scripts/verify-attribution.mjs                          text report, default windows
 *   node scripts/verify-attribution.mjs --from 2026-09-01 --to 2026-09-27
 *   node scripts/verify-attribution.mjs --guard-since 2026-09-28  C9 becomes a hard gate
 *   node scripts/verify-attribution.mjs --json --sample 25
 *
 *   --from/--to    Skopje calendar days, inclusive. Turned into UTC bounds with the
 *                  real Europe/Skopje offset (CET/CEST, DST included). A naked date is
 *                  never sent as a timestamptz — that is the 02:00-Skopje boundary bug.
 *   --guard-since  when the "AlterCPA never writes money" guard went live: YYYY-MM-DD
 *                  or YYYY-MM-DDTHH:MM (Skopje wall clock), or ISO with Z / an offset.
 *                  C9 FAILs only on rows at/after it; without it C9 can only WARN.
 *   --sample N     sample rows per check (default 10, 0 = none, max 200)
 *   --json         one JSON document on stdout instead of the table
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / bad arguments / DB unreachable.
 *
 * Windows   C7, BASELINE  orders created --from (default 2026-08-01) .. --to (default today)
 *           C8, C10       all time — they are invariants; narrowed only by an explicit --from/--to
 *           C9            order_history, the last 30 Skopje days (or the explicit --from/--to)
 *
 * Safety. Pinned to Macedonia: the ref is a constant and the run is refused unless
 * supabase/config.toml agrees. Every statement passes assertReadOnly() — a single
 * SELECT/WITH, no write keyword or side-effect function outside literals — AND is
 * sent with read_only: true, so Postgres itself refuses a write that slipped past
 * the text check. The access token comes from .env and is never printed.
 *
 * Not-yet-deployed schema (the pending MEX-ledger migration: public.mex_parcels,
 * orders.paid_basis, orders.mex_*) is probed through information_schema; dependent
 * checks SKIP, or fall back and WARN, until it lands. Nothing here needs editing
 * when it does.
 *
 * Adding a check (next phases: source / leaderboard): append to CHECKS. run(ctx)
 * reads only through ctx.sql() and returns
 *   { status: 'PASS'|'FAIL'|'WARN'|'SKIP', count, sample[], note, window?, breakdown? }
 * and the runner adds id/title. A check that throws is reported as FAIL (WARN when
 * it is informational) instead of taking the whole run down.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';            // Macedonia — the ONLY project this script queries
const FORBIDDEN_REF = 'sxymaloycddnoxudxaqp';  // live Bulgaria — never
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const TZ = 'Europe/Skopje';

const PROOF_FROM = '2026-08-01';   // MEX proof is owed for every order created from here on
const C9_DAYS = 30;
const MEX_DELIVERED = 2;           // MEX current_status_id; mex-reconcile maps 2 → paid, 7 → returned
const MEX_STATUS = {
  1: 'In Delivery', 2: 'Delivered', 3: 'Problematic', 4: 'Picked Up', 7: 'Return to sender',
  8: 'Shipment created', 9: 'Delivery Attempted', 10: 'In Transit', 13: 'Rejected',
};
const PAID_BASIS_EXEMPT = ['operator_ruling', 'legacy_import'];
const MONEY_STATUSES = ['paid', 'returned', 'shipped', 'delivered'];
const MKD_PER_EUR = 61.5;          // FROZEN (src/lib/currency.ts) — display only, never used to re-price
const SAMPLE_DEFAULT = 10;
const SAMPLE_MAX = 200;
const EXIT = { OK: 0, FAIL: 1, ERROR: 2 };

class Refusal extends Error {}
class UsageError extends Error {}

// ── guard ───────────────────────────────────────────────────────────────────

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

function assertReadOnly(sql) {
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

// ── Skopje calendar → UTC ───────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function skopjeParts(ms) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second };
}
/** Skopje wall clock minus UTC at an instant: +1h in winter (CET), +2h in summer (CEST). */
function skopjeOffsetMs(ms) {
  const t = Math.floor(ms / 1000) * 1000;
  const p = skopjeParts(t);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t;
}
/** A Skopje wall-clock time → the UTC instant it names (DST-aware). */
function skopjeToUtc(y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = wall - skopjeOffsetMs(wall);
  const off = skopjeOffsetMs(t);
  if (wall - off !== t) t = wall - off;   // the guess landed on the other side of a DST switch
  return new Date(t);
}
const ymdParts = (ymd) => ymd.split('-').map(Number);
const skopjeMidnightIso = (ymd) => { const [y, m, d] = ymdParts(ymd); return skopjeToUtc(y, m, d).toISOString(); };
const addDays = (ymd, n) => { const [y, m, d] = ymdParts(ymd); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
const skopjeToday = () => { const p = skopjeParts(Date.now()); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)}`; };
const skopjeStamp = (ms) => { const p = skopjeParts(ms); return `${p.y}-${pad2(p.mo)}-${pad2(p.d)} ${pad2(p.h)}:${pad2(p.mi)}`; };

function validYmd(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = ymdParts(s);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** --guard-since: a Skopje day, a Skopje wall-clock time, or an explicit ISO instant. */
function parseInstant(s) {
  if (validYmd(s)) return skopjeMidnightIso(s);
  const local = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (local && validYmd(local[1]) && +local[2] < 24 && +local[3] < 60 && +(local[4] ?? 0) < 60) {
    const [y, m, d] = ymdParts(local[1]);
    return skopjeToUtc(y, m, d, +local[2], +local[3], +(local[4] ?? 0)).toISOString();
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s) && !Number.isNaN(Date.parse(s))) {
    return new Date(s).toISOString();
  }
  return null;
}

/** A window of Skopje days [from, to] as UTC bounds [fromUtc, toUtc). Null = unbounded. */
function makeWindow(from, to) {
  return {
    from, to,
    fromUtc: from ? skopjeMidnightIso(from) : null,
    toUtc: to ? skopjeMidnightIso(addDays(to, 1)) : null,
  };
}
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const tsLit = (iso) => { if (!ISO_RE.test(iso)) throw new Error(`bad instant ${iso}`); return `'${iso}'::timestamptz`; };
const within = (col, w) =>
  [w.fromUtc && `${col} >= ${tsLit(w.fromUtc)}`, w.toUtc && `${col} < ${tsLit(w.toUtc)}`].filter(Boolean).join(' AND ') || 'true';
const describeWindow = (w, what = 'created') => (w.from || w.to
  ? `${what} ${w.from ?? 'beginning'} .. ${w.to ?? 'now'} Skopje = [${w.fromUtc ?? '-inf'}, ${w.toUtc ?? '+inf'}) UTC`
  : `all time (${what})`);

// ── SQL fragments ───────────────────────────────────────────────────────────

const lit = (s) => `'${String(s).replace(/'/g, "''")}'`;
const SOURCE = (a) => `coalesce(${a}.source_type, '-') || '/' || coalesce(${a}.external_source, '-')`;
const skDay = (col) => `to_char(${col} AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD')`;
const skMin = (col) => `to_char(${col} AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI')`;
const eur2 = (expr) => `round(coalesce(${expr}, 0)::numeric, 2)`;
/** [{k, n, eur?}] grouped by one column of a CTE, biggest first. */
const kv = (rel, col, { eur = true } = {}) =>
  `(SELECT coalesce(json_agg(t ORDER BY t.n DESC, t.k), '[]') FROM (SELECT ${col} AS k, count(*)::int AS n${eur ? `, ${eur2('sum(price)')} AS eur` : ''} FROM ${rel} GROUP BY 1) t)`;

// Mirror of src/lib/utils.ts isSyntheticProductName — keep the two in step
// (scripts/backfill-placeholder-product-names.mjs carries a JS copy as well).
// JS .trim() strips Unicode whitespace (NBSP, BOM, the Zs spaces, U+2028/9), so
// this trim does too; btrim() alone strips only ASCII spaces and would disagree
// with the UI about a name padded with NBSP.
const JS_WS = String.raw`[\s\xa0\x1680\x2000-\x200a\x2028\x2029\x202f\x205f\x3000\xfeff]`;   // hex escapes (Postgres ARE): NBSP, U+1680, U+2000-200A, U+2028/9, U+202F, U+205F, U+3000, BOM
const jsTrim = (col) => `regexp_replace(coalesce(${col}, ''), '^${JS_WS}+|${JS_WS}+$', '', 'g')`;
export const syntheticSql = (col) =>
  `(${jsTrim(col)} IN ('', chr(8212)) OR ${jsTrim(col)} ~* '^(Cancelled|Trashed|No prior product on file)')`;

const NUMERIC_TYPE = /^(smallint|integer|bigint|numeric|real|double precision)$/;
const TIME_TYPE = /^(timestamp|date)/;
const missingCols = (parcels, cols) => cols.filter((c) => !(c in parcels.cols));
/** status_id = 2, whatever type the migration gave the column. */
const deliveredSql = (a, parcels) => (NUMERIC_TYPE.test(parcels.cols.status_id)
  ? `${a}.status_id = ${MEX_DELIVERED}` : `${a}.status_id::text = '${MEX_DELIVERED}'`);
/** COD in denari; MEX sends it as a string, so tolerate a text column too. */
const codSql = (a, parcels) => (NUMERIC_TYPE.test(parcels.cols.cod_mkd)
  ? `${a}.cod_mkd` : `nullif(regexp_replace(${a}.cod_mkd::text, '[^0-9.]', '', 'g'), '')::numeric`);
const parcelsGone = (parcels, missing) => (parcels.exists
  ? `mex_parcels lacks column(s) ${missing.join(', ')}`
  : 'mex_parcels is not deployed yet (pending MEX-ledger migration)');

// ── checks ──────────────────────────────────────────────────────────────────

async function c7PaidWithoutProof(ctx) {
  const { parcels, orderCols } = ctx.schema;
  const w = ctx.windows.range;
  const missing = parcels.exists ? missingCols(parcels, ['order_id', 'status_id', 'tracking_id']) : ['(table)'];
  const ledger = parcels.exists && !missing.length;
  const exempt = 'paid_basis' in orderCols;
  // Parcels are aggregated once and hash-joined — never probed per order — so this
  // stays fast whatever indexes the migration gives mex_parcels.
  const [r] = await ctx.sql(`
WITH pl AS (
  ${ledger ? `SELECT mp.order_id, bool_or(${deliveredSql('mp', parcels)}) AS delivered,
         string_agg(mp.tracking_id || ':' || mp.status_id::text, ', ' ORDER BY mp.tracking_id) AS parcels
  FROM public.mex_parcels mp WHERE mp.order_id IS NOT NULL GROUP BY mp.order_id`
    : 'SELECT NULL::uuid AS order_id, false AS delivered, NULL::text AS parcels WHERE false'}
), x AS (
  SELECT o.id, o.display_id, o.created_at, o.paid_at, o.price, ${SOURCE('o')} AS source, o.mex_tracking_id, pl.parcels
  FROM public.orders o LEFT JOIN pl ON pl.order_id = o.id
  WHERE o.status = 'paid' AND ${within('o.created_at', w)}
    ${exempt ? `AND (o.paid_basis IS NULL OR o.paid_basis::text NOT IN (${PAID_BASIS_EXEMPT.map(lit).join(', ')}))` : ''}
    AND ${ledger ? 'pl.delivered IS NOT TRUE' : 'o.mex_tracking_id IS NULL'}
), last_paid AS (
  SELECT DISTINCT ON (h.order_id) h.order_id, h.changed_by_name
  FROM public.order_history h JOIN x ON x.id = h.order_id
  WHERE h.to_status = 'paid'
  ORDER BY h.order_id, h.changed_at DESC
), y AS (
  SELECT x.*, coalesce(lp.changed_by_name, '(no paid history row)') AS paid_by,
         CASE WHEN x.parcels IS NULL THEN 'no parcel linked' ELSE 'linked parcel(s) not delivered' END AS proof_state
  FROM x LEFT JOIN last_paid lp ON lp.order_id = x.id
)
SELECT (SELECT count(*) FROM y)::int AS n,
  (SELECT ${eur2('sum(price)')} FROM y) AS eur,
  ${kv('y', 'source')} AS by_source,
  ${kv('y', 'paid_by')} AS by_writer,
  ${kv('y', 'proof_state')} AS by_proof,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT display_id, ${skDay('created_at')} AS created, source, ${eur2('price')} AS eur,
            ${skMin('paid_at')} AS paid_at, paid_by, coalesce(mex_tracking_id, '-') AS tracking,
            coalesce(parcels, '-') AS parcels
     FROM y ORDER BY created_at DESC, display_id LIMIT ${ctx.sampleN}) s) AS sample`);

  const notes = [ledger
    ? `paid orders with no DELIVERED MEX parcel linked (mex_parcels.order_id = orders.id AND status_id = ${MEX_DELIVERED}) — claiming EUR ${fmtNum(r.eur, 2)}`
    : `${parcelsGone(parcels, missing)}. FALLBACK: paid orders with no mex_tracking_id at all — claiming EUR ${fmtNum(r.eur, 2)}. `
      + 'A tracking id is a link, not proof of delivery, so this undercounts; it turns into a hard FAIL once the ledger lands'];
  notes.push(exempt ? `paid_basis ${PAID_BASIS_EXEMPT.join(' / ')} exempt` : 'orders.paid_basis not deployed — no exemptions applied');
  if (ledger && parcels.rows === 0) notes.push('mex_parcels is EMPTY — the backfill has not run, so every paid order counts');
  const sample = r.sample.map((s) => ({ ...s, parcels: ledger ? parcelLabel(s.parcels) : undefined }));
  return {
    status: r.n === 0 ? 'PASS' : ledger ? 'FAIL' : 'WARN',
    count: r.n,
    sample: ledger ? sample : sample.map(({ parcels: _p, ...s }) => s),
    note: notes.join('; '),
    window: describeWindow(w),
    breakdown: {
      by_source: r.by_source,
      by_last_paid_writer: r.by_writer,
      ...(ledger ? { by_proof_state: r.by_proof } : {}),
    },
  };
}

async function c8aSharedTracking(ctx) {
  const w = ctx.windows.invariant;
  const narrowed = Boolean(w.fromUtc || w.toUtc);
  const [r] = await ctx.sql(`
WITH t AS (
  SELECT o.mex_tracking_id AS tracking_id, count(*)::int AS holders,
         count(*) FILTER (WHERE o.status = 'paid')::int AS paid_holders,
         ${eur2("sum(o.price) FILTER (WHERE o.status = 'paid')")} - ${eur2("max(o.price) FILTER (WHERE o.status = 'paid')")} AS excess_paid_eur,
         string_agg(o.status::text, '+' ORDER BY o.status::text) AS statuses,
         string_agg(o.display_id || ' ' || o.status::text || ' ' || coalesce(o.source_type, '-') || ' EUR ' || ${eur2('o.price')}::text,
                    ' | ' ORDER BY o.created_at) AS orders
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND o.status::text <> 'duplicated'
  GROUP BY o.mex_tracking_id
  HAVING count(*) > 1${narrowed ? ` AND bool_or(${within('o.created_at', w)})` : ''}
)
SELECT (SELECT count(*) FROM t)::int AS n,
  (SELECT coalesce(sum(holders), 0) FROM t)::int AS orders_involved,
  (SELECT count(*) FROM t WHERE paid_holders > 1)::int AS double_paid,
  (SELECT coalesce(sum(excess_paid_eur), 0) FROM t) AS excess_paid_eur,
  ${kv('t', 'statuses', { eur: false })} AS by_statuses,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT tracking_id, holders, orders FROM t
     ORDER BY paid_holders DESC, holders DESC, tracking_id LIMIT ${ctx.sampleN}) s) AS sample`);
  return {
    status: r.n > 0 ? 'FAIL' : 'PASS',
    count: r.n,
    sample: r.sample,
    note: `${fmtNum(r.n)} tracking id(s) held by ${fmtNum(r.orders_involved)} non-duplicated orders; ${fmtNum(r.double_paid)} of them `
      + `carry 2+ PAID orders (one delivery counted as revenue more than once: EUR ${fmtNum(r.excess_paid_eur, 2)} claimed beyond `
      + 'the first order per parcel)'
      + (narrowed ? '; only ids with at least one holder created in the window' : ''),
    window: describeWindow(w),
    breakdown: { by_holder_statuses: r.by_statuses },
  };
}

async function c8bTrackingNotInLedger(ctx) {
  const { parcels } = ctx.schema;
  const w = ctx.windows.invariant;
  const missing = parcels.exists ? missingCols(parcels, ['tracking_id']) : ['(table)'];
  if (!parcels.exists || missing.length) {
    return { status: 'SKIP', count: null, sample: [], note: parcelsGone(parcels, missing), window: describeWindow(w) };
  }
  const [r] = await ctx.sql(`
WITH t AS (
  SELECT o.display_id, o.status::text AS status, o.created_at, o.mex_tracking_id, ${SOURCE('o')} AS source, o.price
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND ${within('o.created_at', w)}
    AND NOT EXISTS (SELECT 1 FROM public.mex_parcels mp WHERE mp.tracking_id = o.mex_tracking_id)
)
SELECT (SELECT count(*) FROM t)::int AS n,
  ${kv('t', 'status')} AS by_status,
  ${kv('t', 'source')} AS by_source,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT display_id, status, ${skDay('created_at')} AS created, source, mex_tracking_id AS tracking
     FROM t ORDER BY created_at DESC, display_id LIMIT ${ctx.sampleN}) s) AS sample`);
  return {
    status: r.n > 0 ? 'FAIL' : 'PASS',
    count: r.n,
    sample: r.sample,
    note: 'orders whose mex_tracking_id is not a parcel in the ledger — the ledger is incomplete, or the order points at a parcel MEX never reported'
      + (parcels.rows === 0 ? '; mex_parcels is EMPTY — backfill not run' : ''),
    window: describeWindow(w),
    breakdown: { by_status: r.by_status, by_source: r.by_source },
  };
}

async function c8cLinkDisagrees(ctx) {
  const { parcels } = ctx.schema;
  const w = ctx.windows.invariant;
  const missing = parcels.exists ? missingCols(parcels, ['tracking_id', 'order_id']) : ['(table)'];
  if (!parcels.exists || missing.length) {
    return { status: 'SKIP', count: null, sample: [], note: parcelsGone(parcels, missing), window: describeWindow(w) };
  }
  const RESEND = 're-send: order moved to a newer parcel of its own';
  const [r] = await ctx.sql(`
WITH own AS (
  SELECT DISTINCT order_id, tracking_id FROM public.mex_parcels WHERE order_id IS NOT NULL
), t AS (
  SELECT mp.tracking_id, ${'status_id' in parcels.cols ? 'mp.status_id::text' : 'NULL::text'} AS parcel_status,
         o.display_id, o.status::text AS order_status, o.mex_tracking_id AS order_tracking, o.created_at,
         CASE WHEN o.mex_tracking_id IS NULL THEN 'order holds no tracking id'
              WHEN own.order_id IS NOT NULL THEN ${lit(RESEND)}
              ELSE 'order points at a parcel not linked to it' END AS kind
  FROM public.mex_parcels mp
  JOIN public.orders o ON o.id = mp.order_id
  LEFT JOIN own ON own.order_id = o.id AND own.tracking_id = o.mex_tracking_id
  WHERE o.mex_tracking_id IS DISTINCT FROM mp.tracking_id AND ${within('o.created_at', w)}
)
SELECT (SELECT count(*) FROM t)::int AS n,
  (SELECT count(*) FROM t WHERE kind = ${lit(RESEND)})::int AS resend,
  ${kv('t', 'kind', { eur: false })} AS by_kind,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT tracking_id AS parcel, parcel_status, display_id, order_status, coalesce(order_tracking, '-') AS order_tracking, kind
     FROM t ORDER BY (kind = ${lit(RESEND)}), created_at DESC LIMIT ${ctx.sampleN}) s) AS sample`);
  const hard = r.n - r.resend;
  return {
    status: hard > 0 ? 'FAIL' : r.resend > 0 ? 'WARN' : 'PASS',
    count: r.n,
    sample: r.sample.map((s) => ({ ...s, parcel_status: parcelLabel(s.parcel_status) })),
    note: `parcels whose linked order carries a different mex_tracking_id: ${hard} contradict the order, ${r.resend} are re-sends `
      + '(the order moved to a newer parcel of its own — WARN only; decide whether the ledger should unlink the old one)',
    window: describeWindow(w),
    breakdown: { by_kind: r.by_kind },
  };
}

async function c9AltercpaNeverWritesMoney(ctx) {
  const w = ctx.windows.c9;
  const guard = ctx.guardSince;
  const lo = guard && guard < w.fromUtc ? guard : w.fromUtc;
  const afterGuard = guard ? `(changed_at >= ${tsLit(guard)})` : 'false';
  const [r] = await ctx.sql(`
WITH a AS (
  SELECT h.order_id, h.changed_at, h.from_status::text AS from_status, h.to_status::text AS to_status, h.changed_by_name
  FROM public.order_history h
  WHERE h.changed_by_name LIKE 'System (altercpa%'
    AND h.to_status::text IN (${MONEY_STATUSES.map(lit).join(', ')})
    AND h.changed_at >= ${tsLit(lo)} AND h.changed_at < ${tsLit(w.toUtc)}
), b AS (SELECT a.*, ${afterGuard} AS after_guard FROM a)
SELECT (SELECT count(*) FROM b)::int AS n,
  (SELECT count(*) FROM b WHERE after_guard)::int AS n_after_guard,
  (SELECT coalesce(json_agg(d ORDER BY d.day), '[]') FROM (
     SELECT ${skDay('changed_at')} AS day, count(*)::int AS n,
            count(*) FILTER (WHERE to_status = 'paid')::int AS paid,
            count(*) FILTER (WHERE to_status = 'returned')::int AS returned,
            count(*) FILTER (WHERE to_status = 'shipped')::int AS shipped,
            count(*) FILTER (WHERE to_status = 'delivered')::int AS delivered,
            count(*) FILTER (WHERE from_status IS NULL)::int AS on_insert,
            count(*) FILTER (WHERE after_guard)::int AS after_guard
     FROM b GROUP BY 1) d) AS by_day,
  ${kv('b', 'changed_by_name', { eur: false })} AS by_writer,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT o.display_id, ${skMin('b.changed_at')} AS changed_at,
            coalesce(b.from_status, '(insert)') || ' -> ' || b.to_status AS change, b.changed_by_name AS changed_by
     FROM b JOIN public.orders o ON o.id = b.order_id
     ORDER BY b.changed_at DESC, o.display_id LIMIT ${ctx.sampleN}) s) AS sample`);
  const byDay = guard ? r.by_day : r.by_day.map(({ after_guard: _g, ...d }) => d);
  let status;
  let note;
  if (guard) {
    status = r.n_after_guard > 0 ? 'FAIL' : 'PASS';
    note = `${fmtNum(r.n_after_guard)} AlterCPA money write(s) at/after the guard (${skopjeStamp(Date.parse(guard))} Skopje)`
      + (r.n - r.n_after_guard ? `; ${fmtNum(r.n - r.n_after_guard)} earlier row(s) in the window predate it (informational)` : '');
  } else {
    status = r.n > 0 ? 'WARN' : 'PASS';
    note = `${fmtNum(r.n)} order_history row(s) where the AlterCPA sync set ${MONEY_STATUSES.join('/')}. `
      + 'Pass --guard-since <guard deploy date> to turn this into a hard gate (FAIL only on rows after it)';
  }
  const shownWindow = { ...w, from: lo === w.fromUtc ? w.from : skopjeStamp(Date.parse(lo)), fromUtc: lo };
  return {
    status,
    count: guard ? r.n_after_guard : r.n,   // what the status is judged on
    sample: r.sample,                        // newest first, so post-guard rows lead
    note: `${note}. Inserts are covered: the sync logs a history row when it creates an order`,
    window: describeWindow(shownWindow, 'changed'),
    breakdown: { by_skopje_day: byDay, by_writer: r.by_writer },
  };
}

async function c10NoGhostParcels(ctx) {
  const w = ctx.windows.invariant;
  const [r] = await ctx.sql(`
WITH g AS (
  SELECT o.display_id, o.status::text AS status, o.created_at, o.price, o.product_name, o.mex_tracking_id,
         ${SOURCE('o')} AS source,
         coalesce(o.price, 0) = 0 AS zero_price,
         ${syntheticSql('o.product_name')} AS synthetic
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND ${within('o.created_at', w)}
), x AS (
  SELECT g.*, CASE WHEN zero_price AND synthetic THEN 'zero price + synthetic name'
                   WHEN zero_price THEN 'zero price' ELSE 'synthetic name' END AS reason
  FROM g WHERE zero_price OR synthetic
)
SELECT (SELECT count(*) FROM x)::int AS n,
  (SELECT count(*) FROM x WHERE status = 'paid')::int AS paid,
  ${kv('x', 'reason', { eur: false })} AS by_reason,
  ${kv('x', 'status', { eur: false })} AS by_status,
  ${kv('x', 'source', { eur: false })} AS by_source,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT display_id, status, ${skDay('created_at')} AS created, source, ${eur2('price')} AS eur,
            coalesce(left(product_name, 40), '(null)') AS product, mex_tracking_id AS tracking
     FROM x ORDER BY created_at DESC, display_id LIMIT ${ctx.sampleN}) s) AS sample`);
  return {
    status: r.n > 0 ? 'FAIL' : 'PASS',
    count: r.n,
    sample: r.sample,
    note: `orders holding a MEX tracking id with price 0/NULL or a synthetic product name (isSyntheticProductName mirror); `
      + `${fmtNum(r.paid)} of them are 'paid'. Such an order cannot be what the courier collected COD for, so the parcel is `
      + 'most likely misattributed and the order it belongs to is left unproven',
    window: describeWindow(w),
    breakdown: { by_reason: r.by_reason, by_status: r.by_status, by_source: r.by_source },
  };
}

async function baseline(ctx) {
  const { parcels } = ctx.schema;
  const w = ctx.windows.range;
  const missing = parcels.exists ? missingCols(parcels, ['order_id', 'status_id', 'cod_mkd']) : ['(table)'];
  const ledger = parcels.exists && !missing.length;
  const period = ledger && TIME_TYPE.test(parcels.cols.delivered_at ?? '');
  // Delivered parcels are aggregated per order once and LEFT JOINed (no per-row probe).
  const [r] = await ctx.sql(`
WITH r AS (
  SELECT o.id, o.status::text AS status, ${SOURCE('o')} AS source, coalesce(o.price, 0) AS price
  FROM public.orders o
  WHERE o.status IN ('paid', 'shipped', 'returned') AND ${within('o.created_at', w)}
), proof AS (
  ${ledger ? `SELECT mp.order_id, true AS proven, sum(${codSql('mp', parcels)}) AS cod_mkd
  FROM public.mex_parcels mp
  WHERE mp.order_id IS NOT NULL AND ${deliveredSql('mp', parcels)}
  GROUP BY mp.order_id`
    : 'SELECT NULL::uuid AS order_id, true AS proven, NULL::numeric AS cod_mkd WHERE false'}
), rp AS (
  SELECT r.*, coalesce(p.proven, false) AS proven, p.cod_mkd FROM r LEFT JOIN proof p ON p.order_id = r.id
)
SELECT
  (SELECT coalesce(json_agg(t ORDER BY t.source, t.status), '[]') FROM (
     SELECT source, status, count(*)::int AS n, ${eur2('sum(price)')} AS eur FROM rp GROUP BY 1, 2) t) AS rows,
  (SELECT count(*) FROM rp WHERE status = 'paid')::int AS paid_n,
  (SELECT ${eur2('sum(price)')} FROM rp WHERE status = 'paid') AS paid_eur,
  (SELECT count(*) FROM rp WHERE status = 'paid' AND proven)::int AS proven_n,
  (SELECT ${eur2('sum(price)')} FROM rp WHERE status = 'paid' AND proven) AS proven_eur,
  (SELECT round(coalesce(sum(cod_mkd), 0)::numeric) FROM rp WHERE status = 'paid' AND proven) AS proven_cod_mkd${period ? `,
  (SELECT count(*) FROM public.mex_parcels mp WHERE ${deliveredSql('mp', parcels)} AND ${within('mp.delivered_at', w)})::int AS period_n,
  (SELECT count(*) FROM public.mex_parcels mp WHERE ${deliveredSql('mp', parcels)} AND mp.order_id IS NULL
     AND ${within('mp.delivered_at', w)})::int AS period_unlinked_n,
  (SELECT round(coalesce(sum(${codSql('mp', parcels)}), 0)::numeric) FROM public.mex_parcels mp
     WHERE ${deliveredSql('mp', parcels)} AND ${within('mp.delivered_at', w)}) AS period_cod_mkd` : ''}`);

  const pivot = new Map();
  for (const row of r.rows) {
    const p = pivot.get(row.source) ?? { source: row.source, paid: 0, paid_eur: 0, shipped: 0, shipped_eur: 0, returned: 0, returned_eur: 0 };
    p[row.status] = row.n;
    p[`${row.status}_eur`] = Number(row.eur);
    pivot.set(row.source, p);
  }
  const bySource = [...pivot.values()];
  const total = bySource.reduce((t, p) => {
    for (const k of Object.keys(t)) if (k !== 'source') t[k] = Math.round((t[k] + p[k]) * 100) / 100;   // cents, no float noise
    return t;
  }, { source: 'TOTAL', paid: 0, paid_eur: 0, shipped: 0, shipped_eur: 0, returned: 0, returned_eur: 0 });
  const claimedMkd = Math.round(Number(r.paid_eur) * MKD_PER_EUR);
  const notes = [`claimed: ${fmtNum(r.paid_n)} paid orders = EUR ${fmtNum(r.paid_eur, 2)} (~${fmtNum(claimedMkd)} MKD at the frozen ${MKD_PER_EUR})`];
  if (ledger) {
    notes.push(`proven: ${fmtNum(r.proven_n)} of them have a delivered parcel linked = EUR ${fmtNum(r.proven_eur, 2)}, `
      + `courier COD ${fmtNum(r.proven_cod_mkd)} MKD (COD can include the 150 MKD delivery fee)`);
    notes.push(period
      ? `courier view: ${fmtNum(r.period_n)} parcels delivered in the window, COD ${fmtNum(r.period_cod_mkd)} MKD, ${fmtNum(r.period_unlinked_n)} linked to no order`
      : 'mex_parcels.delivered_at missing or not a timestamp — courier period view skipped');
  } else {
    notes.push(`proven COD: n/a — ${parcelsGone(parcels, missing)}`);
  }
  return {
    status: 'PASS',
    count: r.paid_n,
    sample: [],
    note: notes.join('; '),
    window: describeWindow(w),
    breakdown: { by_source: [...bySource, total] },
  };
}

export const CHECKS = [
  { id: 'C7', title: 'paid without MEX proof', run: c7PaidWithoutProof },
  { id: 'C8a', title: 'one parcel, one order: tracking id on 2+ live orders', run: c8aSharedTracking },
  { id: 'C8b', title: 'one parcel, one order: order tracking id not in mex_parcels', run: c8bTrackingNotInLedger },
  { id: 'C8c', title: 'one parcel, one order: parcel link disagrees with the order', run: c8cLinkDisagrees },
  { id: 'C9', title: 'AlterCPA never writes money', run: c9AltercpaNeverWritesMoney },
  { id: 'C10', title: 'no ghost parcels', run: c10NoGhostParcels },
  { id: 'BASELINE', title: 'paid / shipped / returned in range, claimed vs proven', run: baseline, informational: true },
];

// ── context + runner ────────────────────────────────────────────────────────

async function probeSchema(sql) {
  const [row] = await sql(`
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mex_parcels') AS has_parcels,
  (SELECT coalesce(json_object_agg(column_name, data_type), '{}') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mex_parcels') AS parcel_cols,
  (SELECT coalesce(json_object_agg(column_name, data_type ORDER BY column_name), '{}') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders' AND (left(column_name, 4) = 'mex_' OR column_name = 'paid_basis')) AS order_cols`);
  const parcels = { exists: Boolean(row.has_parcels), cols: row.parcel_cols ?? {}, rows: null, linked: null, delivered: null };
  if (parcels.exists) {
    const has = (c) => c in parcels.cols;
    const [p] = await sql(`SELECT count(*)::int AS n${has('order_id') ? ', count(order_id)::int AS linked' : ''}${
      has('status_id') ? `, count(*) FILTER (WHERE ${deliveredSql('p', parcels)})::int AS delivered` : ''} FROM public.mex_parcels p`);
    Object.assign(parcels, { rows: p.n, linked: p.linked ?? null, delivered: p.delivered ?? null });
  }
  return { parcels, orderCols: row.order_cols ?? {} };
}

export async function buildContext(opts, sql = runSql) {
  const today = skopjeToday();
  const rangeTo = opts.to ?? today;
  const rangeFrom = opts.from ?? PROOF_FROM;
  if (rangeFrom > rangeTo) {
    throw new UsageError(`window is empty: from ${rangeFrom}${opts.from ? '' : ' (default)'} is after to ${rangeTo}${opts.to ? '' : ' (today)'}`);
  }
  const explicit = Boolean(opts.from || opts.to);
  const c9To = opts.to ?? today;
  return {
    sql,
    today,
    sampleN: opts.sample ?? SAMPLE_DEFAULT,
    guardSince: opts.guardSince ?? null,
    windows: {
      range: makeWindow(rangeFrom, rangeTo),                                        // C7, BASELINE
      invariant: explicit ? makeWindow(opts.from ?? null, opts.to ?? null) : makeWindow(null, null), // C8, C10
      c9: makeWindow(opts.from ?? addDays(c9To, -(C9_DAYS - 1)), c9To),              // C9
    },
    schema: await probeSchema(sql),
  };
}

export async function runChecks(ctx, checks = CHECKS) {
  const results = [];
  for (const c of checks) {
    let r;
    try {
      r = await c.run(ctx);
    } catch (e) {
      if (e instanceof Refusal) throw e;   // a guard trip is a bug in this script — stop everything
      r = { status: c.informational ? 'WARN' : 'FAIL', count: null, sample: [], note: `check could not run: ${scrub(e?.message ?? e)}` };
    }
    results.push({
      id: c.id, title: c.title, status: r.status, count: r.count ?? null, sample: r.sample ?? [], note: r.note ?? '',
      window: r.window ?? null, breakdown: r.breakdown ?? {},
    });
  }
  return results;
}

// ── arguments ───────────────────────────────────────────────────────────────

const USAGE = `usage: node scripts/verify-attribution.mjs [--from YYYY-MM-DD] [--to YYYY-MM-DD]
                                          [--guard-since YYYY-MM-DD|YYYY-MM-DDTHH:MM|ISO] [--sample N] [--json]
Read-only. Dates are Skopje calendar days (inclusive). Exit 1 if any check FAILs, 2 if refused/unreachable.`;

export function parseArgs(argv) {
  const opts = { json: false, sample: SAMPLE_DEFAULT, from: null, to: null, guardSince: null, help: false };
  const valued = { '--from': 'from', '--to': 'to', '--sample': 'sample', '--guard-since': 'guardSince' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === '--json' && val === undefined) opts.json = true;
    else if ((arg === '--help' || arg === '-h') && val === undefined) opts.help = true;
    else if (valued[arg]) {
      if (val === undefined) val = argv[++i];
      if (val === undefined || val.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      opts[valued[arg]] = val;
    } else throw new UsageError(`unknown argument: ${argv[i]}`);
  }
  for (const k of ['from', 'to']) {
    if (opts[k] != null && !validYmd(opts[k])) throw new UsageError(`--${k} must be a real YYYY-MM-DD date, got "${opts[k]}"`);
  }
  if (opts.from && opts.to && opts.from > opts.to) throw new UsageError(`--from ${opts.from} is after --to ${opts.to}`);
  if (typeof opts.sample === 'string') {
    if (!/^\d+$/.test(opts.sample) || +opts.sample > SAMPLE_MAX) throw new UsageError(`--sample must be an integer 0..${SAMPLE_MAX}`);
    opts.sample = +opts.sample;
  }
  if (opts.guardSince != null) {
    const iso = parseInstant(opts.guardSince);
    if (!iso) throw new UsageError(`--guard-since must be YYYY-MM-DD, YYYY-MM-DDTHH:MM (Skopje) or ISO with Z/offset, got "${opts.guardSince}"`);
    opts.guardSince = iso;
  }
  return opts;
}

// ── output ──────────────────────────────────────────────────────────────────

function fmtNum(x, digits = 0) {
  if (x == null || x === '') return '-';
  const n = Number(x);
  return Number.isFinite(n) ? n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : String(x);
}
function parcelLabel(v) {
  if (v == null || v === '-') return v;
  return String(v).replace(/(^|:|, )(\d+)(?=$|,)/g, (_m, pre, id) => `${pre}${id} ${MEX_STATUS[id] ?? '?'}`);
}
const clip = (v, max) => { const s = v == null ? '-' : String(v); return s.length > max ? `${s.slice(0, max - 1)}~` : s; };

function cell(col, v) {
  if (/(^|_)eur$/.test(col) && v != null && v !== '') return fmtNum(v, 2);   // json_agg hands numerics back as numbers
  if (typeof v === 'number') return fmtNum(v, Number.isInteger(v) ? 0 : 2);
  return v;
}
function table(rows, indent = '    ', max = 60) {
  if (!rows.length) return [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))].filter((c) => rows.some((r) => r[c] !== undefined));
  const cells = rows.map((r) => cols.map((c) => clip(cell(c, r[c]), max)));
  const width = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i].length)));
  const numeric = cols.map((c, i) => cells.every((row) => /^-?[\d,.]+$|^-$/.test(row[i])));
  const line = (vals) => indent + vals.map((v, i) => (numeric[i] ? v.padStart(width[i]) : v.padEnd(width[i]))).join('  ').trimEnd();
  return [line(cols), ...cells.map(line)];
}
function inlineKv(items, top = 12) {
  const shown = items.slice(0, top).map((it) => `${it.k} ${fmtNum(it.n)}${it.eur != null ? ` (EUR ${fmtNum(it.eur, 2)})` : ''}`);
  const rest = items.slice(top);
  if (rest.length) shown.push(`+${rest.length} more (${fmtNum(rest.reduce((t, it) => t + it.n, 0))})`);
  return shown.join(' | ') || '(none)';
}
/** Word-wrap: the first line starts with `first`, the rest are indented to match it. */
function wrap(text, first, width = 118) {
  const rest = ' '.repeat(first.length);
  const out = [];
  let line = '';
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    const prefix = out.length ? rest : first;
    if (line && prefix.length + line.length + 1 + word.length > width) { out.push(prefix + line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  if (line) out.push((out.length ? rest : first) + line);
  return out;
}

function printText(ctx, results, summary, exitCode) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (status) => {
    const code = { PASS: 32, FAIL: 31, WARN: 33, SKIP: 90 }[status];
    return color ? `\x1b[${code}m${status.padEnd(6)}\x1b[0m` : status.padEnd(6);
  };
  const { parcels, orderCols } = ctx.schema;
  const W = ctx.windows;
  const out = [];
  out.push(`verify-attribution v1 | Macedonia ${REF} | read-only | ${skopjeStamp(Date.now())} Skopje`);
  out.push(`windows  C7/BASELINE ${describeWindow(W.range).replace(/ = .*/, '')} | C8/C10 ${describeWindow(W.invariant).replace(/ = .*/, '')}`
    + ` | C9 ${describeWindow(W.c9, 'changed').replace(/ = .*/, '')}${ctx.guardSince ? ` | guard since ${skopjeStamp(Date.parse(ctx.guardSince))} Skopje` : ''}`);
  const mexCols = Object.keys(orderCols).filter((c) => c.startsWith('mex_'));
  out.push(`ledger   mex_parcels: ${parcels.exists ? `${fmtNum(parcels.rows)} rows, ${fmtNum(parcels.linked)} linked, ${fmtNum(parcels.delivered)} delivered` : 'not deployed'}`
    + ` | orders.paid_basis: ${'paid_basis' in orderCols ? 'present' : 'not deployed'} | orders.mex_*: ${mexCols.join(', ') || 'none'}`);
  out.push('');
  const idW = Math.max(8, ...results.map((r) => r.id.length));
  out.push(`${'ID'.padEnd(idW)}  STATUS  ${'COUNT'.padStart(7)}  CHECK`);
  for (const r of results) out.push(`${r.id.padEnd(idW)}  ${paint(r.status)}  ${fmtNum(r.count).padStart(7)}  ${r.title}`);
  const tally = `${summary.FAIL} FAIL, ${summary.WARN} WARN, ${summary.PASS} PASS, ${summary.SKIP} SKIP -> exit ${exitCode}`;
  out.push('', tally);

  for (const r of results) {
    out.push('', `[${r.id}] ${r.title} — ${r.status}${r.count != null ? ` (${fmtNum(r.count)})` : ''}`);
    if (r.window) out.push(`  window  ${r.window}`);
    if (r.note) out.push(...wrap(r.note, '  note    '));
    for (const [name, items] of Object.entries(r.breakdown)) {
      if (!Array.isArray(items) || !items.length) continue;
      const label = `  ${name.replace(/_/g, ' ')}`;
      const isKv = items.every((it) => 'k' in it && 'n' in it && Object.keys(it).every((k) => ['k', 'n', 'eur'].includes(k)));
      if (isKv) out.push(...wrap(inlineKv(items), `${label}  `));
      else out.push(label, ...table(items));
    }
    if (r.sample.length) {
      out.push(`  sample (${r.sample.length}${r.count != null ? ` of ${fmtNum(r.count)}` : ''})`);
      out.push(...table(r.sample, '    ', r.id === 'C8a' ? 110 : 48));
    }
  }
  out.push('', tally);
  console.log(out.join('\n'));
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) { console.log(USAGE); return EXIT.OK; }
  TOKEN = loadToken();
  const ctx = await buildContext(opts);
  const results = await runChecks(ctx);
  const summary = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) summary[r.status]++;
  const exitCode = summary.FAIL ? EXIT.FAIL : EXIT.OK;
  if (opts.json) {
    const { parcels, orderCols } = ctx.schema;
    console.log(JSON.stringify({
      tool: 'verify-attribution', version: 1, ref: REF, read_only: true,
      generated_at: new Date().toISOString(), generated_at_skopje: skopjeStamp(Date.now()),
      windows: ctx.windows, guard_since: ctx.guardSince, sample: ctx.sampleN,
      schema: {
        mex_parcels: parcels.exists ? { rows: parcels.rows, linked: parcels.linked, delivered: parcels.delivered, columns: parcels.cols } : null,
        orders_paid_basis: 'paid_basis' in orderCols,
        orders_mex_columns: Object.keys(orderCols).filter((c) => c.startsWith('mex_')),
      },
      summary, exit_code: exitCode, results,
    }, null, 2));
  } else {
    printText(ctx, results, summary, exitCode);
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
    if (argv.includes('--json')) console.log(JSON.stringify({ tool: 'verify-attribution', ok: false, kind, error: msg }));
    console.error(`verify-attribution ${kind}: ${msg}${e instanceof UsageError ? `\n${USAGE}` : ''}`);
    process.exitCode = EXIT.ERROR;
  });
}
