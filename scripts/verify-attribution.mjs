/**
 * verify-attribution — READ-ONLY proof that the money is attributed correctly
 * No shebang: the test suite imports this file, and Vite's SSR transform leaves a
 * shebang below the injected imports, which Node then rejects. Run with `node`.
 * and that every "paid" is backed by the courier (MEX Poshta).
 *
 *   node scripts/verify-attribution.mjs                          text report, default windows
 *   node scripts/verify-attribution.mjs --from 2026-09-01 --to 2026-09-27
 *   node scripts/verify-attribution.mjs --guard-since 2026-09-28  C9 becomes a hard gate
 *   node scripts/verify-attribution.mjs --json --sample 25
 *   node scripts/verify-attribution.mjs --c8a-template             prints the SQL + JSON entries for the C8a exception list
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
 * Windows   C1-C3, C6, C7, C13, C14, BASELINE   --from (default 2026-08-01) .. --to (default today)
 *           C8, C10, C12  all time — they are invariants; narrowed only by an explicit --from/--to
 *           C9            order_history, the last 30 Skopje days (or the explicit --from/--to)
 *
 * The connected Overview (migration 20260936000000) — C1/C2/C3/C6 call public.insights_overview
 * read-only for the window, exactly as GET /api/insights/overview does, and tie it out:
 *   C1   KPI tiles = Σ of the six departments = single-statement SQL over the same rows (placed,
 *        confirmed, delivered cash) and Σ buckets = placed; lists delivered parcels whose order
 *        the Overview cannot book as delivered cash
 *   C2   MEX-only cash = Σ COD of delivered parcels no order owns, and each department's share
 *        of them by the owner's series rule (28.09.2026, migrations 20260942000500 and
 *        20260942001000): web claim / NTMK… / M… → web · 9110 → Affiliate – Lead in · 9103 →
 *        Affiliate – Lead out · 9102 → Телешоп – Lead out · 9108, 1300 → Social media ·
 *        anything else (9100 …) → Телешоп – Lead in
 *   C3   Prediction-lists tab (insights_lists, 20260941000400) = the cohort's prediction_list
 *        split summed over the departments, exactly (sale clock; a list sale sits in its
 *        parcel's department, 20260942001860), and its footer = the Affiliate – Lead out card;
 *        the "list not recorded" rows are listed.
 *        Before that migration: the old tab (insights_orders_rollup) vs the Overview's split
 *   C6   proven cash = Σ COD of linked delivered parcels; COD − price × 61.5 splits into exact /
 *        +150 delivery fee / listed mismatches
 *   C8a  a tracking id on 2+ live orders FAILs — except the owner-accepted pairs (owner decision
 *        28.09.2026: keep both orders on the 3 parcels held by two orders) listed with a reason in
 *        scripts/data/c8a-accepted-duplicates.json: those read INFO; a new double claim still FAILs,
 *        a stale entry WARNs (see judgeC8a; --c8a-template prints the entries to paste)
 *   C12  orders.sale_source never NULL      C13  ≥ 99% of v_sales_work decisions have a person
 *   C14  insights_web_block = the shop's own classifier over web_orders (SKIP until web-sync lands)
 * The TV leaderboard (migration 20260939000000) — C4/C5 call public.leaderboard_day for the last
 * 7 Skopje days of the range and tie each board out per person per day:
 *   C4   prediction board = ElyonCRM (elyon_crm) sales by sold_by_person_id + v_sales_work CRM
 *        decisions; every crm_prediction member on the board; day total = the SOLD-clock count
 *   C5   pending board = AlterCPA/affiliate sales + the AlterCPA ledger decisions (v_sales_work);
 *        every altercpa_leads member on the board; day total incl. live-credited approvals
 * They SKIP while the objects they read are not deployed.
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
import { loadAcceptedDuplicates, classifyDoubleClaims, DOUBLE_CLAIMS_SQL } from './lib/accepted-duplicates.mjs';

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

/**
 * C7's population as the two CTEs `pl` (delivered-parcel proof per order) and `x` (the paid
 * orders created in window `w` with no DELIVERED MEX parcel linked; paid_basis
 * operator_ruling / legacy_import exempt). The check below and
 * scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid share this text, so the
 * repair selects EXACTLY the orders C7 counts. `ledger` / `exempt` / `delivered` are the
 * check's schema fallbacks; a repair always runs on the deployed ledger (the defaults).
 */
export function c7PopulationCtes({ w, ledger = true, exempt = true, delivered = `mp.status_id = ${MEX_DELIVERED}` }) {
  return `pl AS (
  ${ledger ? `SELECT mp.order_id, bool_or(${delivered}) AS delivered,
         string_agg(mp.tracking_id || ':' || mp.status_id::text, ', ' ORDER BY mp.tracking_id) AS parcels
  FROM public.mex_parcels mp WHERE mp.order_id IS NOT NULL GROUP BY mp.order_id`
    : 'SELECT NULL::uuid AS order_id, false AS delivered, NULL::text AS parcels WHERE false'}
), x AS (
  SELECT o.id, o.display_id, o.created_at, o.paid_at, o.price, ${SOURCE('o')} AS source, o.mex_tracking_id, pl.parcels
  FROM public.orders o LEFT JOIN pl ON pl.order_id = o.id
  WHERE o.status = 'paid' AND ${within('o.created_at', w)}
    ${exempt ? `AND (o.paid_basis IS NULL OR o.paid_basis::text NOT IN (${PAID_BASIS_EXEMPT.map(lit).join(', ')}))` : ''}
    AND ${ledger ? 'pl.delivered IS NOT TRUE' : 'o.mex_tracking_id IS NULL'}
)`;
}

/**
 * The ids C7 FAILs on with its default window (created PROOF_FROM .. today, Skopje) — one
 * read-only SELECT (`id`, `display_id`). `from`/`to` are Skopje days, as --from/--to.
 */
export function c7PopulationSql({ from = null, to = null } = {}) {
  const w = makeWindow(from ?? PROOF_FROM, to ?? skopjeToday());
  return `WITH ${c7PopulationCtes({ w })}
SELECT x.id, x.display_id FROM x`;
}

async function c7PaidWithoutProof(ctx) {
  const { parcels, orderCols } = ctx.schema;
  const w = ctx.windows.range;
  const missing = parcels.exists ? missingCols(parcels, ['order_id', 'status_id', 'tracking_id']) : ['(table)'];
  const ledger = parcels.exists && !missing.length;
  const exempt = 'paid_basis' in orderCols;
  // Parcels are aggregated once and hash-joined — never probed per order — so this
  // stays fast whatever indexes the migration gives mex_parcels.
  const [r] = await ctx.sql(`
WITH ${c7PopulationCtes({ w, ledger, exempt, delivered: ledger ? deliveredSql('mp', parcels) : undefined })}, last_paid AS (
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

/**
 * C8a — one parcel, one order. A tracking id named by 2+ live (non-duplicated) orders FAILs,
 * EXCEPT the owner-accepted pairs (owner decision 28.09.2026: "keep both orders on the 3
 * parcels held by two orders — they may be identical but both are accurate"). The exception
 * is DATA, not code: scripts/data/c8a-accepted-duplicates.json lists each accepted
 * (tracking id, exact set of orders) with its reason and owner date
 * (scripts/lib/accepted-duplicates.mjs). An accepted pair is reported as INFO and does not
 * fail; any other double claim — a new tracking id, or a third order joining an accepted
 * one — still FAILs; an entry that no longer matches a double claim WARNs (clean the file) — on
 * a full-history run only: a date-narrowed run does not see pairs created outside its window;
 * an unreadable/invalid file FAILs (it must never silently accept everything).
 * `node scripts/verify-attribution.mjs --c8a-template` prints the SQL + ready entries.
 */
export function judgeC8a({ doubles, accepted, narrowed = false, sampleN = SAMPLE_DEFAULT }) {
  const file = accepted.file ? String(accepted.file).split(/[\\/]/).slice(-3).join('/') : 'scripts/data/c8a-accepted-duplicates.json';
  const cls = classifyDoubleClaims(doubles, accepted.errors?.length ? [] : accepted.entries);
  // A narrowed run only sees double claims with a holder created in the window, so an accepted pair
  // from another month is simply out of view — staleness is judged on a full-history run only.
  const outOfWindow = narrowed ? cls.stale.length : 0;
  if (narrowed) cls.stale = [];
  const paidOf = (d) => d.holders.filter((h) => h.status === 'paid').map((h) => Number(h.eur) || 0);
  const excess = (d) => { const p = paidOf(d); return p.length > 1 ? p.reduce((a, b) => a + b, 0) - Math.max(...p) : 0; };
  const bad = cls.unaccepted;
  const involved = bad.reduce((n, d) => n + d.holders.length, 0);
  const doublePaid = bad.filter((d) => paidOf(d).length > 1).length;
  const excessEur = Math.round(bad.reduce((n, d) => n + excess(d), 0) * 100) / 100;
  const byStatuses = new Map();
  for (const d of bad) {
    const k = d.holders.map((h) => h.status).sort().join('+');
    byStatuses.set(k, (byStatuses.get(k) || 0) + 1);
  }
  const line = (d) => d.holders.map((h) => `${h.display_id} ${h.status} ${h.source ?? '-'} EUR ${Number(h.eur ?? 0).toFixed(2)}`).join(' | ');
  const sample = [...bad]
    .sort((a, b) => paidOf(b).length - paidOf(a).length || b.holders.length - a.holders.length || a.tracking_id.localeCompare(b.tracking_id))
    .slice(0, sampleN)
    .map((d) => ({ tracking_id: d.tracking_id, holders: d.holders.length, orders: line(d) }));
  const invalid = accepted.errors?.length ? accepted.errors : null;
  const status = invalid || bad.length ? 'FAIL' : (cls.stale.length || cls.changed.length) ? 'WARN' : 'PASS';
  const notes = [
    `${fmtNum(bad.length)} tracking id(s) held by ${fmtNum(involved)} non-duplicated orders outside the owner-accepted list; ${fmtNum(doublePaid)} of them `
      + `carry 2+ PAID orders (one delivery counted as revenue more than once: EUR ${fmtNum(excessEur, 2)} claimed beyond the first order per parcel)`,
    `INFO: ${fmtNum(cls.accepted.length)} owner-accepted double claim(s) (C8a exception, ${file}) — both orders are kept, not a failure`,
  ];
  if (invalid) notes.push(`the exception file is INVALID (${invalid.join('; ')}) — no pair is accepted until it is fixed`);
  if (accepted.missing) notes.push(`the exception file ${file} is missing — no pair is accepted`);
  if (cls.changed.length) notes.push(`${cls.changed.length} accepted tracking id(s) are now held by a DIFFERENT set of orders (${cls.changed.map((e) => `${e.tracking_id}: accepted ${e.orders.join('+')}, now ${e.now_held_by.join('+')}`).join('; ')}) — that is a new double claim`);
  if (cls.stale.length) notes.push(`${cls.stale.length} exception(s) no longer match any double claim (${cls.stale.map((e) => e.tracking_id).join(', ')}) — remove them from ${file}`);
  if (bad.length) notes.push(`if the owner accepts one: node scripts/verify-attribution.mjs --c8a-template, then add the entry to ${file}`);
  if (narrowed) notes.push('only ids with at least one holder created in the window'
    + (outOfWindow ? `; ${outOfWindow} accepted pair(s) lie outside it (staleness is judged on a full-history run)` : ''));
  return {
    status,
    count: bad.length,
    sample,
    note: notes.join('; '),
    breakdown: {
      by_holder_statuses: [...byStatuses].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => ({ k, n })),
      owner_accepted: cls.accepted.map((d) => ({ tracking_id: d.tracking_id, orders: d.holders.map((h) => `${h.display_id} ${h.status}`).join(' + '), owner_date: d.owner_date, reason: d.reason })),
      stale_exceptions: cls.stale.map((e) => ({ tracking_id: e.tracking_id, orders: e.orders.join(' + '), owner_date: e.owner_date })),
    },
  };
}

async function c8aSharedTracking(ctx) {
  const w = ctx.windows.invariant;
  const narrowed = Boolean(w.fromUtc || w.toUtc);
  const rows = await ctx.sql(`
WITH t AS (
  SELECT o.mex_tracking_id AS tracking_id,
         json_agg(json_build_object('display_id', o.display_id, 'status', o.status::text, 'source', coalesce(o.source_type, '-'),
                                    'eur', ${eur2('o.price')}) ORDER BY o.created_at, o.display_id) AS holders
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND o.status::text <> 'duplicated'
  GROUP BY o.mex_tracking_id
  HAVING count(*) > 1${narrowed ? ` AND bool_or(${within('o.created_at', w)})` : ''}
)
SELECT tracking_id, holders FROM t ORDER BY tracking_id LIMIT 5000`);
  const accepted = ctx.acceptedDuplicates ?? loadAcceptedDuplicates();
  return { ...judgeC8a({ doubles: rows, accepted, narrowed, sampleN: ctx.sampleN }), window: describeWindow(w) };
}

/** --c8a-template: the read-only SQL + a ready JSON entry per double claim live now. */
async function printC8aTemplate() {
  const rows = await runSql(DOUBLE_CLAIMS_SQL);
  const today = skopjeToday();
  const acc = loadAcceptedDuplicates();
  const known = new Set((acc.entries || []).map((e) => `${e.tracking_id}#${e.key}`));
  const out = [
    'C8a exception template — READ-ONLY. The SQL (run it yourself read-only if you prefer):',
    '', DOUBLE_CLAIMS_SQL, '',
    `${rows.length} tracking id(s) are held by two or more live orders now. Paste into "accepted" of`,
    'scripts/data/c8a-accepted-duplicates.json ONLY the entries the owner accepted (3 on 28.09.2026),',
    'with the reason filled in; any other double claim must stay a FAIL.', '',
  ];
  for (const r of rows) {
    const orders = Array.isArray(r.orders) ? r.orders : [];
    const already = known.has(`${r.tracking_id}#${[...orders].map((d) => String(d).toUpperCase()).sort().join('|')}`);
    out.push(`// ${r.tracking_id}: ${r.detail}${already ? '   [already accepted]' : ''}`);
    out.push(`${JSON.stringify({ tracking_id: r.tracking_id, orders, reason: 'Owner 28.09.2026: both orders are real — <say why>', owner_date: today })},`);
  }
  console.log(out.join('\n'));
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

/**
 * C10 — no ghost parcels. An order holding a MEX tracking id with price 0/NULL or a synthetic
 * product name FAILs, EXCEPT a consistent replacement (owner ruling 28.09.2026 — a free
 * replacement shipment is "not an order"): price 0/NULL on a REAL product name AND the parcel
 * it names is in mex_parcels with COD 0. Nothing was claimed and nothing was collected, so no
 * money can be misattributed; those read INFO. A synthetic 0 ден disposition row never
 * qualifies (a COD-0 parcel on it is still someone else's — e.g. a card-paid web order), nor
 * does a tracking id missing from the register (its COD is unknown).
 */
async function c10NoGhostParcels(ctx) {
  const w = ctx.windows.invariant;
  const { parcels } = ctx.schema;
  const register = parcels.exists && !missingCols(parcels, ['tracking_id', 'cod_mkd']).length;
  const [r] = await ctx.sql(`
WITH g AS (
  SELECT o.display_id, o.status::text AS status, o.created_at, o.price, o.product_name, o.mex_tracking_id,
         ${SOURCE('o')} AS source,
         coalesce(o.price, 0) = 0 AS zero_price,
         ${syntheticSql('o.product_name')} AS synthetic
  FROM public.orders o
  WHERE o.mex_tracking_id IS NOT NULL AND ${within('o.created_at', w)}
), y AS (
  SELECT g.*, CASE WHEN zero_price AND synthetic THEN 'zero price + synthetic name'
                   WHEN zero_price THEN 'zero price' ELSE 'synthetic name' END AS reason,
         ${register ? `(SELECT ${codSql('mp', parcels)} FROM public.mex_parcels mp WHERE mp.tracking_id = g.mex_tracking_id)` : 'NULL::numeric'} AS parcel_cod
  FROM g WHERE zero_price OR synthetic
), z AS (
  SELECT y.*, coalesce(zero_price AND NOT synthetic AND parcel_cod = 0, false) AS replacement FROM y
), x AS (SELECT * FROM z WHERE NOT replacement
), ok AS (SELECT * FROM z WHERE replacement)
SELECT (SELECT count(*) FROM x)::int AS n,
  (SELECT count(*) FROM x WHERE status = 'paid')::int AS paid,
  (SELECT count(*) FROM ok)::int AS replacements,
  ${kv('x', 'reason', { eur: false })} AS by_reason,
  ${kv('x', 'status', { eur: false })} AS by_status,
  ${kv('x', 'source', { eur: false })} AS by_source,
  ${kv('ok', 'source', { eur: false })} AS replacements_by_source,
  (SELECT coalesce(json_agg(s), '[]') FROM (
     SELECT display_id, status, ${skDay('created_at')} AS created, source, ${eur2('price')} AS eur,
            coalesce(left(product_name, 40), '(null)') AS product, mex_tracking_id AS tracking,
            coalesce(parcel_cod::text, 'not in register') AS parcel_cod_mkd
     FROM x ORDER BY created_at DESC, display_id LIMIT ${ctx.sampleN}) s) AS sample`);
  return {
    status: r.n > 0 ? 'FAIL' : 'PASS',
    count: r.n,
    sample: r.sample,
    note: `orders holding a MEX tracking id with price 0/NULL or a synthetic product name (isSyntheticProductName mirror); `
      + `${fmtNum(r.paid)} of them are 'paid'. Such an order cannot be what the courier collected COD for, so the parcel is `
      + 'most likely misattributed and the order it belongs to is left unproven; '
      + `INFO: ${fmtNum(r.replacements)} consistent replacement(s) — price 0 on a real product and parcel COD 0 `
      + `(owner ruling 28.09.2026: a free replacement shipment is not an order) — not a failure`
      + (register ? '' : '; mex_parcels.cod_mkd not deployed — no replacement can be recognised'),
    window: describeWindow(w),
    breakdown: { by_reason: r.by_reason, by_status: r.by_status, by_source: r.by_source, replacements_by_source: r.replacements_by_source },
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

// ── connected Overview (migration 20260936000000) ───────────────────────────
// C1/C2/C3/C6 call public.insights_overview read-only for the --from/--to
// window (default 2026-08-01 .. today) and hold it against single-statement
// SQL over the same rows. The window is passed exactly as the api passes it:
// Skopje 00:00 of the first day, the last microsecond of the last day.

const OV_EUR_TOL = 0.05;   // Σ of per-source figures, each rounded to the cent
const OV_MKD_TOL = 4;      // Σ of per-source figures, each rounded to the denar
const SALE_STATUSES_SQL = `('confirmed', 'shipped', 'delivered', 'paid', 'returned')`;
const SOLD_STATUSES_SQL = `('confirmed', 'shipped', 'delivered', 'paid')`;
const NOT_MONADON = (a) => `(${a}.source_type IS NULL OR ${a}.source_type <> 'monadon_legacy')`;
// The owner's test phones (public.report_excluded_phones, 20260939000700). Since
// 20260940000300 the Overview (insights_overview / insights_web_block) leaves out an order
// on such a phone (last 8 digits) or holding such a parcel, a web order on such a phone or
// linked to such a parcel, and such a parcel — so its SQL twins here do the same, once that
// migration is in (ctx.schema.fns.testPhonesOut; no_parcel_rule_days() is its marker).
const XP = '(SELECT public.report_excluded_phone8s())::text[]';
const TEST_ORDER = (a) => `(right(regexp_replace(coalesce(${a}.customer_phone, ''), '[^0-9]', '', 'g'), 8) = ANY (${XP})
      OR coalesce(${a}.mex_tracking_id IN (SELECT xp.tracking_id FROM public.mex_parcels xp WHERE xp.phone8 = ANY (${XP})), false))`;
const notTestOrder = (ctx, a) => (ctx.schema.fns.testPhonesOut ? `NOT ${TEST_ORDER(a)}` : 'true');
const notTestOrderId = (ctx, col) => (ctx.schema.fns.testPhonesOut
  ? `NOT coalesce(${col} IN (SELECT xo.id FROM public.orders xo WHERE ${TEST_ORDER('xo')}), false)` : 'true');
const notTestParcel = (ctx, a) => (ctx.schema.fns.testPhonesOut ? `NOT coalesce(${a}.phone8 = ANY (${XP}), false)` : 'true');
/** [fromUtc, toUtc) → the inclusive µs end the api hands the RPC. */
const inclusiveEnd = (iso) => new Date(Date.parse(iso) - 1).toISOString().replace(/Z$/, '999Z');

function needOverview(ctx, w) {
  const { overview, canOverview } = ctx.schema.fns;
  if (overview && canOverview) return null;
  return { status: overview ? 'WARN' : 'SKIP', count: null, sample: [], window: describeWindow(w),
           note: overview
             ? 'public.insights_overview exists but this read-only role may not EXECUTE it — the GRANT to supabase_read_only_user in migration 20260936000000 is missing'
             : 'public.insights_overview is not deployed yet (migration 20260936000000)' };
}

/** The RPC's answer for a window — fetched once per window per run. */
function overviewOf(ctx, w) {
  const key = `${w.fromUtc}|${w.toUtc}`;
  ctx.overviewCache ??= new Map();
  if (!ctx.overviewCache.has(key)) {
    ctx.overviewCache.set(key, ctx.sql(
      `SELECT public.insights_overview(${lit(w.fromUtc)}, ${lit(inclusiveEnd(w.toUtc))}) AS j`,
    ).then(([r]) => r.j));
  }
  return ctx.overviewCache.get(key);
}

const num = (v) => Number(v ?? 0);
const sumSources = (ov, f) => ov.sources.reduce((t, s) => t + num(f(s)), 0);
const r2 = (x) => Math.round(x * 100) / 100;
/** One row of a tie-out table; `ok` when every present figure agrees within tol. */
function tieRow(metric, figures, tol) {
  const vals = Object.values(figures).filter((v) => v != null).map(Number);
  const spread = vals.length ? Math.max(...vals) - Math.min(...vals) : 0;
  return { metric, ...figures, diff: r2(spread), ok: spread <= tol };
}

async function c1SourcesTieOut(ctx) {
  const w = ctx.windows.range;
  const skip = needOverview(ctx, w);
  if (skip) return skip;
  const ov = await overviewOf(ctx, w);
  // The web shop mirror's share of placed comes from the RPC itself (C14 holds
  // it against web_orders); everything else is recomputed from public.orders.
  const shop = ov.sources.find((s) => s.key === 'web')?.placed_shop ?? { count: 0, value_mkd: 0 };
  const [t] = await ctx.sql(`
WITH placed AS (
  SELECT count(*)::int AS n, coalesce(sum(o.price), 0) AS eur
  FROM public.orders o WHERE ${within('o.created_at', w)} AND ${NOT_MONADON('o')} AND ${notTestOrder(ctx, 'o')}
), conf AS (
  SELECT count(*)::int AS n, coalesce(sum(o.price), 0) AS eur
  FROM public.orders o
  WHERE ${NOT_MONADON('o')} AND coalesce(o.sale_source_detail, '') <> 'disposition'
    AND (o.sold_at IS NOT NULL OR o.status::text IN ${SALE_STATUSES_SQL})
    AND ${within('coalesce(o.sold_at, o.confirmed_at, o.created_at)', w)} AND ${notTestOrder(ctx, 'o')}
), parcels AS (
  SELECT count(*)::int AS n, coalesce(sum(p.cod_mkd), 0)::bigint AS mkd
  FROM public.mex_parcels p WHERE p.status_id = ${MEX_DELIVERED} AND ${within('p.delivered_at', w)}
    AND ${notTestParcel(ctx, 'p')} AND ${notTestOrderId(ctx, 'p.order_id')}
), unproven AS (
  SELECT count(*)::int AS n, coalesce(sum(round(coalesce(o.price, 0) * ${MKD_PER_EUR})), 0)::bigint AS mkd
  FROM public.orders o
  WHERE o.status::text IN ('paid', 'delivered') AND o.mex_delivered_at IS NULL AND ${NOT_MONADON('o')}
    AND ${within('coalesce(o.paid_at, o.created_at)', w)} AND ${notTestOrder(ctx, 'o')}
), odd AS (
  -- delivered parcels whose order the overview cannot book as delivered cash
  SELECT p.tracking_id, o.display_id, o.status::text AS order_status, p.cod_mkd,
         CASE WHEN o.status::text NOT IN ('paid', 'delivered') THEN 'order not paid'
              WHEN o.mex_tracking_id IS DISTINCT FROM p.tracking_id THEN 'order names another parcel'
              ELSE 'order has no mex_delivered_at' END AS why
  FROM public.mex_parcels p JOIN public.orders o ON o.id = p.order_id
  WHERE p.status_id = ${MEX_DELIVERED} AND ${within('p.delivered_at', w)}
    AND (o.status::text NOT IN ('paid', 'delivered') OR o.mex_tracking_id IS DISTINCT FROM p.tracking_id
         OR o.mex_delivered_at IS NULL)
    AND ${notTestParcel(ctx, 'p')} AND ${notTestOrder(ctx, 'o')}
)
SELECT (SELECT n FROM placed) + ${Number(shop.count) || 0} AS placed_n,
       round((SELECT eur FROM placed) + ${Number(shop.value_mkd) || 0} / ${MKD_PER_EUR}, 2) AS placed_eur,
       (SELECT n FROM conf) AS conf_n, round((SELECT eur FROM conf), 2) AS conf_eur,
       (SELECT n FROM parcels) + (SELECT n FROM unproven) AS cash_n,
       (SELECT mkd FROM parcels) + (SELECT mkd FROM unproven) AS cash_mkd,
       (SELECT count(*) FROM odd)::int AS odd_n,
       (SELECT coalesce(json_agg(s), '[]') FROM (SELECT * FROM odd ORDER BY tracking_id LIMIT ${ctx.sampleN}) s) AS odd`);

  const k = ov.kpis;
  const rows = [
    tieRow('placed (count)', { tile: k.placed.count, sum_sources: sumSources(ov, (s) => s.placed?.count), sql_truth: t.placed_n }, 0),
    tieRow('placed (EUR)', { tile: k.placed.value_eur, sum_sources: r2(sumSources(ov, (s) => s.placed?.value_eur)), sql_truth: num(t.placed_eur) }, OV_EUR_TOL),
    tieRow('confirmed (count)', { tile: k.confirmed.count, sum_sources: sumSources(ov, (s) => s.confirmed), sql_truth: t.conf_n }, 0),
    tieRow('confirmed (EUR)', { tile: k.confirmed.value_eur, sum_sources: r2(sumSources(ov, (s) => s.confirmed_value_eur)), sql_truth: num(t.conf_eur) }, OV_EUR_TOL),
    tieRow('delivered (count)', { tile: k.delivered.count, sum_sources: sumSources(ov, (s) => s.cash?.count), sql_truth: t.cash_n - t.odd_n }, 0),
    tieRow('delivered (MKD)', { tile: k.delivered.cod_mkd, sum_sources: sumSources(ov, (s) => s.cash?.cod_mkd),
                                sql_truth: num(t.cash_mkd) - t.odd.reduce((a, o) => a + num(o.cod_mkd), 0) }, OV_MKD_TOL),
    tieRow('buckets = placed', { tile: k.placed.count,
      sum_buckets: ov.sources.reduce((a, s) => a + Object.entries(s.buckets || {})
        .filter(([b]) => b !== 'mex_only').reduce((x, [, v]) => x + num(v.count), 0), 0) }, 0),
  ];
  const bad = rows.filter((r) => !r.ok);
  return {
    status: bad.length ? 'FAIL' : t.odd_n ? 'WARN' : 'PASS',
    count: bad.length,
    sample: t.odd,
    note: `KPI tiles vs Σ of the six departments vs single-statement SQL over the same rows (placed = created, confirmed = sold_at `
      + `→ confirmed_at → created_at, delivered = MEX delivered_at, else paid_at). ${bad.length} figure(s) disagree`
      + (t.odd_n ? `; ${fmtNum(t.odd_n)} delivered parcel(s) sit on an order the overview cannot book as delivered cash (listed)` : ''),
    window: describeWindow(w),
    breakdown: { tie_out: rows },
  };
}

async function c2MexOnlyCash(ctx) {
  const w = ctx.windows.range;
  const skip = needOverview(ctx, w);
  if (skip) return skip;
  const ov = await overviewOf(ctx, w);
  const claimed = ctx.schema.tables.webOrders
    ? `EXISTS (SELECT 1 FROM public.web_orders wo WHERE wo.mex_tracking_id = p.tracking_id AND wo.deleted_in_shop_at IS NULL)`
    : 'false';
  const [t] = await ctx.sql(`
WITH u0 AS (
  SELECT p.account, coalesce(p.series, '-') AS series, coalesce(p.cod_mkd, 0) AS cod,
         (coalesce(p.sender_reference, '') ~ '^NTMK' OR p.tracking_id ~ '^NTMK' OR p.tracking_id ~ '^M[0-9]' OR ${claimed}) AS web,
         p.series AS ser
  FROM public.mex_parcels p
  WHERE p.status_id = ${MEX_DELIVERED} AND p.order_id IS NULL AND ${within('p.delivered_at', w)}
    AND ${notTestParcel(ctx, 'p')}
),
u AS (   -- the owner's profile + series rule, stated here on its own (the Overview's is cohort_parcel_split):
         -- BIO NATURAL is affiliate before anything else, never web / teleshop (20260942001860)
  SELECT u0.*, CASE WHEN u0.account = 'bio_natural' AND u0.ser = '9110' THEN 'altercpa'
                    WHEN u0.account = 'bio_natural' THEN 'elyon_crm'
                    WHEN u0.web THEN 'web'
                    WHEN u0.ser = '9110' THEN 'altercpa'
                    WHEN u0.ser = '9103' THEN 'elyon_crm'
                    WHEN u0.ser = '9102' THEN 'teleshop_out'
                    WHEN u0.ser IN ('9108', '1300') THEN 'social'
                    ELSE 'teleshop_other' END AS src
  FROM u0
)
SELECT count(*)::int AS n, coalesce(sum(cod), 0)::bigint AS mkd,
       count(*) FILTER (WHERE web)::int AS web_n, coalesce(sum(cod) FILTER (WHERE web), 0)::bigint AS web_mkd,
       (SELECT coalesce(json_object_agg(x.src, x.n), '{}') FROM (SELECT src, count(*)::int AS n FROM u GROUP BY 1) x) AS by_src,
       (SELECT coalesce(json_agg(b ORDER BY b.n DESC), '[]') FROM (
          SELECT account, series, count(*)::int AS n, sum(cod)::bigint AS cod_mkd FROM u GROUP BY 1, 2) b) AS by_series
FROM u`);
  const src = (key) => ov.sources.find((s) => s.key === key)?.cash ?? {};
  const rows = [
    tieRow('MEX-only (count)', { tile: ov.kpis.delivered.mex_only_count, sum_sources: sumSources(ov, (s) => s.cash?.mex_only_count), sql_truth: t.n }, 0),
    tieRow('MEX-only (MKD)', { tile: ov.kpis.delivered.mex_only_cod_mkd, sum_sources: sumSources(ov, (s) => s.cash?.mex_only_cod_mkd), sql_truth: num(t.mkd) }, OV_MKD_TOL),
    // each department's parcels with no order, by the series rule (owner 28.09.2026)
    ...['altercpa', 'elyon_crm', 'teleshop_out', 'teleshop_other', 'social', 'web'].map((k) =>
      tieRow(`${k} parcels (count)`, { source: num(src(k).mex_only_count), sql_truth: num(t.by_src?.[k]) }, 0)),
  ];
  const bad = rows.filter((r) => !r.ok);
  return {
    status: bad.length ? 'FAIL' : 'PASS',
    count: t.n,
    sample: [],
    note: `delivered MEX parcels no order owns, delivered in the window: ${fmtNum(t.n)} = ${fmtNum(t.mkd)} MKD `
      + `(${fmtNum(t.web_n)} the web shop's, ${fmtNum(t.n - t.web_n)} credited by series to the other five departments)`,
    window: describeWindow(w),
    breakdown: { tie_out: rows, by_series: t.by_series },
  };
}

/** C3 since the rebuild (migration 20260941000400): the Prediction-lists tab reads THE sale
 *  cohort (insights_lists over insights_sale_rows), so it must EQUAL the cohort's Affiliate –
 *  Lead out (elyon_crm) · prediction_list split — sale clock, exact — and Σ its lists + "list not recorded" must be
 *  its total. Every remaining row is explained (a sale whose list was not recorded, with the
 *  original it was duplicated from). Until the migration is applied, the pre-rebuild
 *  comparison below runs instead. */
async function c3PredictionListsTab(ctx) {
  const w = ctx.windows.range;
  const [p] = await ctx.sql(`
SELECT coalesce(has_function_privilege(to_regprocedure('public.insights_lists(timestamptz,timestamptz,timestamptz,timestamptz,boolean,integer)'), 'execute'), false) AS lists,
       coalesce(has_function_privilege(to_regprocedure('public.insights_cohort(timestamptz,timestamptz,timestamptz,timestamptz,text[],boolean)'), 'execute'), false) AS cohort`);
  if (!p.lists || !p.cohort) {
    const legacy = await c3LegacyPredictionListsTab(ctx);
    return { ...legacy, note: `${legacy.note ?? ''} [insights_lists (migration 20260941000400) not deployed or not executable by this role yet — the pre-rebuild tab is compared]`.trim() };
  }
  const from = lit(w.fromUtc);
  const to = lit(inclusiveEnd(w.toUtc));
  const [t] = await ctx.sql(`
SELECT public.insights_lists(${from}, ${to}, NULL, NULL, true, 7) AS lists,
       public.insights_cohort(${from}, ${to}, NULL, NULL, ARRAY['altercpa','elyon_crm','teleshop_out','teleshop_other','social','web'], true) AS cohort`);
  const L = typeof t.lists === 'string' ? JSON.parse(t.lists) : t.lists;
  const C = typeof t.cohort === 'string' ? JSON.parse(t.cohort) : t.cohort;
  // A list sale is in its parcel's department (20260942001860: BIO NATURAL or no parcel yet →
  // Affiliate – Lead out, a NATURA parcel by its series), never its agent's team: the tab holds
  // the prediction_list split of EVERY department.
  const listSplits = (C.by_source ?? []).map((src) => src.splits?.find((x) => x.key === 'prediction_list') ?? {});
  const split = { count: listSplits.reduce((a, x) => a + num(x.count), 0), value_mkd: listSplits.reduce((a, x) => a + num(x.value_mkd), 0) };
  const card = (C.by_source ?? []).find((s) => s.key === 'elyon_crm')?.total ?? {};
  const nr = L.not_recorded ?? { count: 0, value_mkd: 0, samples: [] };
  const sumLists = (k) => (L.lists ?? []).reduce((a, l) => a + num(l[k]), 0);
  const rows = [
    tieRow('tab sales = Overview Σ departments · prediction_list', { tab: num(L.total?.count), overview: num(split.count) }, 0),
    tieRow('tab денари = Overview Σ departments · prediction_list', { tab: num(L.total?.value_mkd), overview: num(split.value_mkd) }, 0),
    tieRow('Σ lists + list not recorded = tab (sales)', { lists: sumLists('count') + num(nr.count), tab: num(L.total?.count) }, 0),
    tieRow('Σ lists + list not recorded = tab (денари)', { lists: sumLists('value_mkd') + num(nr.value_mkd), tab: num(L.total?.value_mkd) }, 0),
    tieRow('tab Affiliate – Lead out footer = Overview Affiliate – Lead out card', { tab: num(L.elyon_crm?.count), overview: num(card.count) }, 0),
  ];
  const bad = rows.filter((r) => !r.ok);
  return {
    status: bad.length ? 'FAIL' : 'PASS',
    count: num(nr.count),
    sample: (nr.samples ?? []).map((s) => ({
      display_id: s.display_id,
      why: `list not recorded — shown on the tab in its own row, inside the total${s.dup_of ? `; duplicate of ${s.dup_of}${s.dup_of_list ? ` (list "${s.dup_of_list}")` : ''}` : ''}`,
    })),
    note: `Prediction-lists tab (sale clock) ${fmtNum(L.total?.count)} sales / ${fmtNum(L.total?.value_mkd)} ден = Overview Σ departments · `
      + `prediction_list ${fmtNum(split.count)} / ${fmtNum(split.value_mkd)} ден; ${fmtNum(nr.count)} of them carry no list `
      + `("list not recorded" row — the /orders duplicate endpoint copies the list since 28.09.2026)`,
    window: describeWindow(w),
    breakdown: { tie_out: rows },
  };
}

/** The pre-rebuild C3: the old tab (insights_orders_rollup, created day, list id) against the
 *  Overview's ElyonCRM / prediction_list split — kept only until 20260941000400 is applied. */
async function c3LegacyPredictionListsTab(ctx) {
  const w = ctx.windows.range;
  const skip = needOverview(ctx, w);
  if (skip) return skip;
  const ov = await overviewOf(ctx, w);
  const split = ov.sources.find((s) => s.key === 'elyon_crm')?.splits?.find((s) => s.key === 'prediction_list') ?? {};
  const tabRpc = ctx.schema.fns.canRollup
    ? `(SELECT coalesce(sum((x ->> 'revenue')::numeric), 0) FROM jsonb_array_elements(
          public.insights_orders_rollup(${lit(w.fromUtc)}, ${lit(inclusiveEnd(w.toUtc))}) -> 'prediction') x)`
    : 'NULL::numeric';
  const [t] = await ctx.sql(`
WITH tab AS (      -- the Prediction-lists tab: list-attributed orders still sold
  SELECT o.id, o.display_id, o.price, o.status::text AS status, o.sale_source, o.sale_source_detail
  FROM public.orders o
  WHERE o.prediction_list_id IS NOT NULL AND ${within('o.created_at', w)} AND ${NOT_MONADON('o')}
    AND o.status::text IN ${SOLD_STATUSES_SQL}
), ovr AS (        -- the Overview: ElyonCRM / prediction_list, still sold
  SELECT o.id, o.display_id, o.price, o.status::text AS status, o.sale_source, o.sale_source_detail
  FROM public.orders o
  WHERE o.sale_source = 'elyon_crm' AND o.sale_source_detail = 'prediction_list'
    AND ${within('o.created_at', w)} AND ${NOT_MONADON('o')}
    AND o.status::text IN ${SOLD_STATUSES_SQL} AND ${notTestOrder(ctx, 'o')}
), only_tab AS (SELECT * FROM tab WHERE id NOT IN (SELECT id FROM ovr)),
   only_ovr AS (SELECT * FROM ovr WHERE id NOT IN (SELECT id FROM tab))
SELECT (SELECT count(*) FROM tab)::int AS tab_n, (SELECT ${eur2('sum(price)')} FROM tab) AS tab_eur,
       ${tabRpc} AS tab_rpc_eur,
       (SELECT count(*) FROM ovr)::int AS ovr_n, (SELECT ${eur2('sum(price)')} FROM ovr) AS ovr_eur,
       (SELECT count(*) FROM only_tab)::int AS only_tab_n, (SELECT ${eur2('sum(price)')} FROM only_tab) AS only_tab_eur,
       (SELECT count(*) FROM only_ovr)::int AS only_ovr_n, (SELECT ${eur2('sum(price)')} FROM only_ovr) AS only_ovr_eur,
       (SELECT coalesce(json_agg(s), '[]') FROM (
          SELECT display_id, status, ${eur2('price')} AS eur, 'tab only: ' || coalesce(sale_source, '-') || '/' || coalesce(sale_source_detail, '-') AS why
          FROM only_tab
          UNION ALL
          SELECT display_id, status, ${eur2('price')}, 'overview only: list attribution missing on the order'
          FROM only_ovr
          ORDER BY 3 DESC, 1 LIMIT ${ctx.sampleN}) s) AS sample`);
  const rows = [
    tieRow('RPC split = its SQL (EUR)', { rpc: num(split.sold_value_eur), sql: num(t.ovr_eur) }, 0.005),
    tieRow('RPC split = its SQL (count)', { rpc: num(split.sold_count), sql: t.ovr_n }, 0),
  ];
  if (t.tab_rpc_eur != null) rows.push(tieRow('tab RPC = tab SQL (EUR)', { rpc: num(t.tab_rpc_eur), sql: num(t.tab_eur) }, 0.005));
  const explained = r2(num(t.tab_eur) - num(t.only_tab_eur) + num(t.only_ovr_eur));
  rows.push(tieRow('tab − tab-only + overview-only = overview (EUR)', { lhs: explained, overview: num(t.ovr_eur) }, 0.005));
  const bad = rows.filter((r) => !r.ok);
  const differ = t.only_tab_n + t.only_ovr_n;
  return {
    status: bad.length ? 'FAIL' : differ ? 'WARN' : 'PASS',
    count: differ,
    sample: t.sample,
    note: `Prediction-lists tab (list-attributed, still sold) ${fmtNum(t.tab_n)} / EUR ${fmtNum(t.tab_eur, 2)} vs Overview `
      + `ElyonCRM prediction_list ${fmtNum(t.ovr_n)} / EUR ${fmtNum(t.ovr_eur, 2)}; ${fmtNum(differ)} order(s) sit on one side only `
      + `(tab only ${fmtNum(t.only_tab_n)} / EUR ${fmtNum(t.only_tab_eur, 2)}, overview only ${fmtNum(t.only_ovr_n)} / EUR ${fmtNum(t.only_ovr_eur, 2)})`,
    window: describeWindow(w),
    breakdown: { tie_out: rows },
  };
}

async function c6ProvenCash(ctx) {
  const w = ctx.windows.range;
  const skip = needOverview(ctx, w);
  if (skip) return skip;
  const ov = await overviewOf(ctx, w);
  const [t] = await ctx.sql(`
WITH lp AS (
  SELECT p.tracking_id, o.display_id, coalesce(p.cod_mkd, 0) AS cod,
         round(coalesce(o.price, 0) * ${MKD_PER_EUR}) AS price_mkd,
         coalesce(p.cod_mkd, 0) - round(coalesce(o.price, 0) * ${MKD_PER_EUR}) AS d,
         (o.status::text IN ('paid', 'delivered') AND o.mex_tracking_id = p.tracking_id
          AND o.mex_delivered_at IS NOT NULL) AS booked
  FROM public.mex_parcels p JOIN public.orders o ON o.id = p.order_id
  WHERE p.status_id = ${MEX_DELIVERED} AND ${within('p.delivered_at', w)}
    AND ${notTestParcel(ctx, 'p')} AND ${notTestOrder(ctx, 'o')}
), c AS (
  SELECT lp.*, CASE WHEN abs(d) <= 3 THEN 'exact' WHEN abs(d - 150) <= 3 THEN 'fee_150' ELSE 'mismatch' END AS cls
  FROM lp
)
SELECT count(*)::int AS n, coalesce(sum(cod), 0)::bigint AS cod,
       count(*) FILTER (WHERE booked)::int AS booked_n, coalesce(sum(cod) FILTER (WHERE booked), 0)::bigint AS booked_cod,
       (SELECT coalesce(json_agg(b ORDER BY b.cls), '[]') FROM (
          SELECT cls, count(*)::int AS n, sum(cod)::bigint AS cod_mkd, sum(price_mkd)::bigint AS price_mkd, sum(d)::bigint AS diff_mkd
          FROM c GROUP BY cls) b) AS by_class,
       (SELECT coalesce(json_agg(s), '[]') FROM (
          SELECT display_id, tracking_id, cod AS cod_mkd, price_mkd, d AS diff_mkd FROM c
          WHERE cls = 'mismatch' ORDER BY abs(d) DESC, display_id LIMIT ${ctx.sampleN}) s) AS sample,
       count(*) FILTER (WHERE cls = 'mismatch')::int AS mismatch_n
FROM c`);
  const rpcLinked = num(ov.kpis.delivered.proven_cod_mkd) - num(ov.kpis.delivered.mex_only_cod_mkd);
  const rpcLinkedN = num(ov.kpis.delivered.proven_count) - num(ov.kpis.delivered.mex_only_count);
  const rows = [
    tieRow('proven cash on orders (MKD)', { rpc: rpcLinked, sql_booked: num(t.booked_cod) }, OV_MKD_TOL),
    tieRow('proven cash on orders (count)', { rpc: rpcLinkedN, sql_booked: t.booked_n }, 0),
  ];
  const bad = rows.filter((r) => !r.ok);
  const unbooked = t.n - t.booked_n;
  return {
    status: bad.length ? 'FAIL' : (t.mismatch_n || unbooked) ? 'WARN' : 'PASS',
    count: t.mismatch_n,
    sample: t.sample,
    note: `linked delivered parcels in the window: ${fmtNum(t.n)} = ${fmtNum(t.cod)} MKD; the Overview books ${fmtNum(t.booked_n)} of them `
      + `(${fmtNum(t.booked_cod)} MKD)${unbooked ? `, ${fmtNum(unbooked)} sit on an order that is not paid or names another parcel (C1 lists them)` : ''}. `
      + `COD − price × ${MKD_PER_EUR} splits into exact / +150 delivery fee / mismatch (listed, COD ≠ price: report only)`,
    window: describeWindow(w),
    breakdown: { tie_out: rows, by_class: t.by_class },
  };
}

async function c12SaleSourceNeverNull(ctx) {
  const w = ctx.windows.invariant;
  const [t] = await ctx.sql(`
SELECT count(*)::int AS n,
       count(*) FILTER (WHERE o.sale_source IS NULL)::int AS no_source,
       count(*) FILTER (WHERE o.sale_source_detail IS NULL)::int AS no_detail,
       (SELECT coalesce(json_agg(s), '[]') FROM (
          SELECT o2.display_id, ${skDay('o2.created_at')} AS created, ${SOURCE('o2')} AS intake
          FROM public.orders o2 WHERE o2.sale_source IS NULL AND ${within('o2.created_at', w)}
          ORDER BY o2.created_at DESC LIMIT ${ctx.sampleN}) s) AS sample
FROM public.orders o WHERE ${within('o.created_at', w)}`);
  return {
    status: t.no_source ? 'FAIL' : t.no_detail ? 'WARN' : 'PASS',
    count: t.no_source,
    sample: t.sample,
    note: `${fmtNum(t.no_source)} of ${fmtNum(t.n)} orders have no sale_source (trg_orders_sale_source_fill leaves it NULL only when `
      + `classification failed); ${fmtNum(t.no_detail)} have no sale_source_detail`,
    window: describeWindow(w),
    breakdown: {},
  };
}

async function c13DecisionsHavePerson(ctx) {
  const w = ctx.windows.range;
  if (!ctx.schema.tables.work) {
    return { status: 'SKIP', count: null, sample: [], note: 'public.v_sales_work is not deployed (migration 20260935000100)', window: describeWindow(w, 'decided') };
  }
  const [t] = await ctx.sql(`
WITH v AS (SELECT * FROM public.v_sales_work WHERE ${within('at', w)})
SELECT count(*)::int AS n, count(person_id)::int AS with_person,
       (SELECT coalesce(json_agg(b ORDER BY b.via), '[]') FROM (
          SELECT via, count(*)::int AS decisions, count(person_id)::int AS with_person FROM v GROUP BY via) b) AS by_via,
       (SELECT coalesce(json_agg(s ORDER BY s.decisions DESC), '[]') FROM (
          SELECT via, coalesce(actor_ext, '(none)') AS unmapped_actor, count(*)::int AS decisions,
                 ${skDay('max(at)')} AS last_decision
          FROM v WHERE person_id IS NULL GROUP BY 1, 2 ORDER BY 3 DESC LIMIT ${ctx.sampleN}) s) AS sample
FROM v`);
  const share = t.n ? t.with_person / t.n : 1;
  return {
    status: share >= 0.99 ? 'PASS' : 'FAIL',
    count: t.n - t.with_person,
    sample: t.sample,
    note: `${fmtNum(t.with_person)} of ${fmtNum(t.n)} decisions (${(share * 100).toFixed(2)}%) resolve to a sales person; `
      + 'the gate is 99%. Unmapped actors go to Settings → Teams (sales_person_identities)',
    window: describeWindow(w, 'decided'),
    breakdown: { by_via: t.by_via },
  };
}

// ── C4 / C5 — the TV leaderboard (migration 20260939000000) ────────────────
// public.leaderboard_day(day, mode) is called for each of the last LB_DAYS
// Skopje days of the range and tied out, per person per day, against twins
// written here independently of the function:
//   stamped sales  board (confirmed − live_credited) = orders of the board's
//                  source with sold_at in the day, by sold_by_person_id
//   work           board worked / sale_decisions = v_sales_work rows of the day
//                  in the board's scope (C4: CRM decisions on elyon_crm orders;
//                  C5: AlterCPA ledger decisions + CRM decisions on lead orders)
//   day total      board summary.sales = the board source's sales on the SOLD
//                  clock (sold_at; unstamped: the AlterCPA approval, else
//                  confirmed_at, else created_at)
//   roster         every member of the board's team that day is on the board,
//                  and so is everyone who sold or worked its source (guests)
const LB_DAYS = 7;
function boardWindow(ctx) {
  const r = ctx.windows.range;
  const to = r.to ?? ctx.today;
  const back = addDays(to, -(LB_DAYS - 1));
  return makeWindow(r.from && r.from > back ? r.from : back, to);
}

async function leaderboardTieOut(ctx, mode) {
  const w = boardWindow(ctx);
  const { board, canBoard } = ctx.schema.fns;
  if (!board || !canBoard) {
    return { status: board ? 'WARN' : 'SKIP', count: null, sample: [], window: describeWindow(w, 'sold'),
             note: board
               ? 'public.leaderboard_day exists but this read-only role may not EXECUTE it — the GRANT to supabase_read_only_user in migration 20260939000000 is missing'
               : 'public.leaderboard_day is not deployed yet (migration 20260939000000)' };
  }
  const src = mode === 'prediction' ? `o.sale_source = 'elyon_crm'` : `o.sale_source IN ('altercpa', 'affiliate')`;
  const work = mode === 'prediction'
    ? `v.via = 'crm' AND v.sale_source = 'elyon_crm'`
    : `(v.via = 'altercpa' OR v.sale_source IN ('altercpa', 'affiliate'))`;
  const saleOrder = `${src} AND coalesce(o.sale_source_detail, '') <> 'disposition' AND ${NOT_MONADON('o')}
    AND (o.sold_at IS NOT NULL OR o.status IN ${SALE_STATUSES_SQL})`;
  const [t] = await ctx.sql(`
WITH d AS (
  SELECT g::date AS day FROM generate_series(${lit(w.from)}::date, ${lit(w.to)}::date, interval '1 day') g
),
b AS (SELECT d.day, public.leaderboard_day(d.day, ${lit(mode)}) AS j FROM d),
br AS (
  SELECT b.day, r ->> 'person_id' AS person_id, r ->> 'name' AS name,
         (r ->> 'confirmed')::int - (r ->> 'live_credited')::int AS stamped_sales,
         (r ->> 'worked')::int AS worked, (r ->> 'sale_decisions')::int AS sale_decisions
  FROM b CROSS JOIN LATERAL jsonb_array_elements(b.j -> 'rows') r
),
ts AS (
  SELECT (o.sold_at AT TIME ZONE 'Europe/Skopje')::date AS day, o.sold_by_person_id::text AS person_id, count(*)::int AS n
  FROM public.orders o
  WHERE ${saleOrder} AND o.sold_by_person_id IS NOT NULL AND ${within('o.sold_at', w)}
  GROUP BY 1, 2
),
tw AS (
  SELECT (v.at AT TIME ZONE 'Europe/Skopje')::date AS day, v.person_id::text AS person_id,
         count(*)::int AS worked, (count(*) FILTER (WHERE v.outcome = 'sale'))::int AS sale_decisions
  FROM public.v_sales_work v
  WHERE ${within('v.at', w)} AND v.person_id IS NOT NULL AND ${work}
  GROUP BY 1, 2
),
k AS (
  SELECT day, person_id FROM br WHERE person_id IS NOT NULL
  UNION SELECT day, person_id FROM ts UNION SELECT day, person_id FROM tw
),
cmp AS (
  SELECT k.day, k.person_id, coalesce(br.name, sp.display_name, k.person_id) AS person,
         (br.person_id IS NOT NULL) AS on_board,
         coalesce(br.stamped_sales, 0) AS board_sales, coalesce(ts.n, 0) AS orders_sales,
         coalesce(br.worked, 0) AS board_worked, coalesce(tw.worked, 0) AS ledger_worked,
         coalesce(br.sale_decisions, 0) AS board_decisions, coalesce(tw.sale_decisions, 0) AS ledger_decisions
  FROM k
  LEFT JOIN br ON br.day = k.day AND br.person_id = k.person_id
  LEFT JOIN ts ON ts.day = k.day AND ts.person_id = k.person_id
  LEFT JOIN tw ON tw.day = k.day AND tw.person_id = k.person_id
  LEFT JOIN public.sales_people sp ON sp.id::text = k.person_id
),
bad AS (
  SELECT * FROM cmp
  WHERE (on_board AND (board_sales <> orders_sales OR board_worked <> ledger_worked OR board_decisions <> ledger_decisions))
     OR (NOT on_board AND (orders_sales > 0 OR ledger_worked > 0))
),
tm AS (
  SELECT d.day, m.person_id::text AS person_id, sp.display_name AS name
  FROM d
  JOIN public.sales_team_members m ON m.valid_from <= d.day AND coalesce(m.valid_to, 'infinity'::date) >= d.day
  JOIN public.sales_teams st ON st.key = m.team_key AND st.leaderboard_mode = ${lit(mode)}
  JOIN public.sales_people sp ON sp.id = m.person_id AND (sp.is_active OR m.valid_to IS NOT NULL)
),
miss AS (SELECT DISTINCT tm.day, tm.name FROM tm WHERE NOT EXISTS (SELECT 1 FROM br WHERE br.day = tm.day AND br.person_id = tm.person_id)),
cand AS (
  SELECT o.id, o.sold_at, o.confirmed_at, o.created_at
  FROM public.orders o
  WHERE ${saleOrder}
    AND (${within('o.sold_at', w)}
         OR (o.sold_at IS NULL AND (${within('o.confirmed_at', w)} OR ${within('o.created_at', w)}
             OR o.id IN (SELECT l.order_id FROM public.altercpa_leads l
                          WHERE l.decision IN ('approved', 'cancel_other') AND ${within('l.decided_at', w)}))))
),
tot AS (
  SELECT (x.sale_at AT TIME ZONE 'Europe/Skopje')::date AS day, count(*)::int AS n
  FROM (SELECT CASE WHEN c.sold_at IS NOT NULL THEN c.sold_at
                    ELSE coalesce((SELECT min(l.decided_at) FROM public.altercpa_leads l
                                    WHERE l.order_id = c.id AND l.decision IN ('approved', 'cancel_other')
                                      AND upper(coalesce(l.geo, '')) = 'MK' AND l.skip_reason IS DISTINCT FROM 'test_order'),
                                  c.confirmed_at, c.created_at) END AS sale_at
        FROM cand c) x
  WHERE ${within('x.sale_at', w)}
  GROUP BY 1
),
days AS (
  SELECT to_char(b.day, 'YYYY-MM-DD') AS day,
         (b.j #>> '{summary,people}')::int AS people, (b.j #>> '{summary,members}')::int AS members,
         (b.j #>> '{summary,guests}')::int AS guests,
         (b.j #>> '{summary,zero_sale_people}')::int AS zero_sale,
         (b.j #>> '{summary,was_online}')::int AS were_online,
         (b.j #>> '{summary,sales}')::int AS board_sales, coalesce(tot.n, 0) AS sql_sales,
         (b.j #>> '{summary,live_credited_sales}')::int AS live_credited,
         (b.j #>> '{summary,unattributed_sales}')::int AS unattributed
  FROM b LEFT JOIN tot ON tot.day = b.day
)
SELECT (SELECT count(*)::int FROM bad) AS n_bad,
       (SELECT count(*)::int FROM miss) AS n_missing,
       (SELECT count(*)::int FROM days WHERE board_sales <> sql_sales) AS n_total_bad,
       (SELECT coalesce(json_agg(s), '[]') FROM (
          SELECT to_char(day, 'YYYY-MM-DD') AS day, person, on_board, board_sales, orders_sales,
                 board_worked, ledger_worked, board_decisions, ledger_decisions
          FROM bad ORDER BY day DESC, person LIMIT ${ctx.sampleN}) s) AS sample,
       (SELECT coalesce(json_agg(s), '[]') FROM (
          SELECT to_char(day, 'YYYY-MM-DD') AS day, name FROM miss ORDER BY day DESC, name LIMIT ${ctx.sampleN}) s) AS missing,
       (SELECT coalesce(json_agg(x ORDER BY x.day), '[]') FROM days x) AS by_day`);
  const failed = t.n_bad + t.n_missing + t.n_total_bad;
  return {
    status: failed ? 'FAIL' : 'PASS',
    count: failed,
    sample: t.sample.length ? t.sample : t.missing,
    note: `${mode} board, last ${LB_DAYS} days: ${fmtNum(t.n_bad)} person-days disagree with the orders / work ledger, `
      + `${fmtNum(t.n_missing)} team member-days missing from the board, ${fmtNum(t.n_total_bad)} days whose sales total differs`,
    window: describeWindow(w, 'sold / decided'),
    breakdown: { by_day: t.by_day, missing: t.missing },
  };
}

const c4PredictionBoard = (ctx) => leaderboardTieOut(ctx, 'prediction');
const c5PendingBoard = (ctx) => leaderboardTieOut(ctx, 'pending');

async function c14WebBlockEqualsShop(ctx) {
  const w = ctx.windows.range;
  if (!ctx.schema.fns.webBlock || !ctx.schema.tables.webOrders) {
    return { status: 'SKIP', count: null, sample: [], window: describeWindow(w),
             note: 'the web shop mirror is not deployed yet (web_orders / insights_web_block, migrations 20260937…)' };
  }
  if (!ctx.schema.fns.canWebBlock) {
    return { status: 'WARN', count: null, sample: [], window: describeWindow(w),
             note: 'insights_web_block exists but this read-only role may not EXECUTE it — grant EXECUTE on it to supabase_read_only_user to enable C14' };
  }
  const [t] = await ctx.sql(`
WITH b AS (SELECT public.insights_web_block(${lit(w.fromUtc)}, ${lit(inclusiveEnd(w.toUtc))}) AS j),
w AS (
  -- the shop's classifyOutcome(), spelled out here on purpose: an independent
  -- twin of public.web_order_outcome (migration 20260937000000)
  SELECT CASE
           WHEN o.payment_method = 'CARD' AND o.status IN ('PENDING', 'CANCELLED')
            AND o.payment_status NOT IN ('PAID', 'PARTIALLY_REFUNDED', 'REFUNDED')       THEN 'card_unpaid'
           WHEN o.status = 'CANCELLED'                                                   THEN 'cancelled'
           WHEN o.status IN ('RETURNED', 'REFUNDED')                                     THEN 'returned'
           WHEN o.status = 'DELIVERED'                                                   THEN 'delivered'
           WHEN o.status = 'DONE' AND o.payment_status IN ('PAID', 'PARTIALLY_REFUNDED') THEN 'delivered'
           WHEN o.status = 'DONE'                                                        THEN 'no_record'
           WHEN o.status = 'SHIPPED'                                                     THEN 'courier'
           WHEN o.status IN ('CONFIRMED', 'PROCESSING')                                  THEN 'preparing'
           ELSE 'awaiting' END AS bucket,
         o.total
  FROM public.web_orders o
  WHERE o.deleted_in_shop_at IS NULL AND ${within('o.created_at', w)} AND ${notTestParcel(ctx, 'o')}
    AND ${ctx.schema.fns.testPhonesOut ? `NOT EXISTS (SELECT 1 FROM public.mex_parcels tp
                     WHERE tp.tracking_id = o.mex_tracking_id AND tp.phone8 = ANY (${XP}))` : 'true'}
), p AS (SELECT * FROM w WHERE bucket <> 'card_unpaid')
SELECT (SELECT count(*) FROM p)::int AS placed_n, (SELECT round(coalesce(sum(total), 0), 2) FROM p) AS placed_mkd,
       (SELECT (j #>> '{placed,count}')::numeric FROM b) AS block_n,
       (SELECT (j #>> '{placed,value_mkd}')::numeric FROM b) AS block_mkd,
       (SELECT coalesce(json_agg(x ORDER BY x.bucket), '[]') FROM (
          SELECT k.bucket, coalesce(q.n, 0) AS sql_n,
                 (SELECT (j -> 'buckets' -> k.bucket ->> 'count')::numeric FROM b) AS block_n
          FROM (VALUES ('awaiting'), ('preparing'), ('courier'), ('delivered'), ('returned'), ('cancelled'), ('no_record')) k(bucket)
          LEFT JOIN (SELECT bucket, count(*)::int AS n FROM p GROUP BY 1) q ON q.bucket = k.bucket) x) AS by_bucket`);
  const rows = [
    tieRow('placed (count)', { block: num(t.block_n), sql: t.placed_n }, 0),
    tieRow('placed (MKD)', { block: num(t.block_mkd), sql: num(t.placed_mkd) }, 0.5),
    ...t.by_bucket.map((b) => tieRow(`bucket ${b.bucket}`, { block: num(b.block_n), sql: b.sql_n }, 0)),
  ];
  const bad = rows.filter((r) => !r.ok);
  return {
    status: bad.length ? 'FAIL' : 'PASS',
    count: bad.length,
    sample: [],
    note: 'insights_web_block vs the shop\'s own classifier over web_orders for the same Skopje days. The last mile — this against '
      + 'the live shop panel — needs the shop database and stays a manual look',
    window: describeWindow(w),
    breakdown: { tie_out: rows },
  };
}

export const CHECKS = [
  { id: 'C1', title: 'Overview: Σ sources = KPI tiles = SQL truth', run: c1SourcesTieOut },
  { id: 'C2', title: 'Overview: MEX-only cash = unlinked delivered parcels', run: c2MexOnlyCash },
  { id: 'C3', title: 'Overview: Prediction-lists tab = the list sales of every department', run: c3PredictionListsTab },
  { id: 'C6', title: 'Overview: proven cash = COD of linked delivered parcels', run: c6ProvenCash },
  { id: 'C7', title: 'paid without MEX proof', run: c7PaidWithoutProof },
  { id: 'C8a', title: 'one parcel, one order: tracking id on 2+ live orders', run: c8aSharedTracking },
  { id: 'C8b', title: 'one parcel, one order: order tracking id not in mex_parcels', run: c8bTrackingNotInLedger },
  { id: 'C8c', title: 'one parcel, one order: parcel link disagrees with the order', run: c8cLinkDisagrees },
  { id: 'C9', title: 'AlterCPA never writes money', run: c9AltercpaNeverWritesMoney },
  { id: 'C10', title: 'no ghost parcels', run: c10NoGhostParcels },
  { id: 'C12', title: 'sale_source never NULL', run: c12SaleSourceNeverNull },
  { id: 'C4', title: 'Leaderboard: prediction board = ElyonCRM sales per person/day', run: c4PredictionBoard },
  { id: 'C5', title: 'Leaderboard: pending board = AlterCPA ledger per person/day', run: c5PendingBoard },
  { id: 'C13', title: '≥ 99% of decisions have a person', run: c13DecisionsHavePerson },
  { id: 'C14', title: 'web block = the shop\'s own classifier', run: c14WebBlockEqualsShop },
  { id: 'BASELINE', title: 'paid / shipped / returned in range, claimed vs proven', run: baseline, informational: true },
];

// ── context + runner ────────────────────────────────────────────────────────

async function probeSchema(sql) {
  const [row] = await sql(`
SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'mex_parcels') AS has_parcels,
  (SELECT coalesce(json_object_agg(column_name, data_type), '{}') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'mex_parcels') AS parcel_cols,
  (SELECT coalesce(json_object_agg(column_name, data_type ORDER BY column_name), '{}') FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'orders' AND (left(column_name, 4) = 'mex_' OR column_name = 'paid_basis')) AS order_cols,
  to_regprocedure('public.insights_overview(text,text,text,text)') IS NOT NULL AS has_overview,
  coalesce(has_function_privilege(to_regprocedure('public.insights_overview(text,text,text,text)'), 'execute'), false) AS can_overview,
  to_regprocedure('public.insights_web_block(text,text)') IS NOT NULL AS has_web_block,
  coalesce(has_function_privilege(to_regprocedure('public.insights_web_block(text,text)'), 'execute'), false) AS can_web_block,
  coalesce(has_function_privilege(to_regprocedure('public.insights_orders_rollup(text,text)'), 'execute'), false) AS can_rollup,
  to_regprocedure('public.leaderboard_day(date,text)') IS NOT NULL AS has_board,
  coalesce(has_function_privilege(to_regprocedure('public.leaderboard_day(date,text)'), 'execute'), false) AS can_board,
  to_regclass('public.web_orders') IS NOT NULL AS has_web_orders,
  to_regclass('public.v_sales_work') IS NOT NULL AS has_work,
  to_regprocedure('public.no_parcel_rule_days()') IS NOT NULL AS test_phones_out`);
  const parcels = { exists: Boolean(row.has_parcels), cols: row.parcel_cols ?? {}, rows: null, linked: null, delivered: null };
  if (parcels.exists) {
    const has = (c) => c in parcels.cols;
    const [p] = await sql(`SELECT count(*)::int AS n${has('order_id') ? ', count(order_id)::int AS linked' : ''}${
      has('status_id') ? `, count(*) FILTER (WHERE ${deliveredSql('p', parcels)})::int AS delivered` : ''} FROM public.mex_parcels p`);
    Object.assign(parcels, { rows: p.n, linked: p.linked ?? null, delivered: p.delivered ?? null });
  }
  return {
    parcels,
    orderCols: row.order_cols ?? {},
    // exists / executable by the role read_only queries run as (supabase_read_only_user)
    fns: { overview: Boolean(row.has_overview), canOverview: Boolean(row.can_overview),
           webBlock: Boolean(row.has_web_block), canWebBlock: Boolean(row.can_web_block),
           canRollup: Boolean(row.can_rollup),
           board: Boolean(row.has_board), canBoard: Boolean(row.can_board),
           // 20260940000300 is in: the Overview leaves the owner's test phones out
           testPhonesOut: Boolean(row.test_phones_out) },
    tables: { webOrders: Boolean(row.has_web_orders), work: Boolean(row.has_work) },
  };
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
       node scripts/verify-attribution.mjs --c8a-template
Read-only. Dates are Skopje calendar days (inclusive). Exit 1 if any check FAILs, 2 if refused/unreachable.`;

export function parseArgs(argv) {
  const opts = { json: false, sample: SAMPLE_DEFAULT, from: null, to: null, guardSince: null, help: false, c8aTemplate: false };
  const valued = { '--from': 'from', '--to': 'to', '--sample': 'sample', '--guard-since': 'guardSince' };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    let val;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) { val = arg.slice(eq + 1); arg = arg.slice(0, eq); }
    if (arg === '--json' && val === undefined) opts.json = true;
    else if (arg === '--c8a-template' && val === undefined) opts.c8aTemplate = true;
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
  out.push(`verify-attribution v2 | Macedonia ${REF} | read-only | ${skopjeStamp(Date.now())} Skopje`);
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
  if (opts.c8aTemplate) { await printC8aTemplate(); return EXIT.OK; }
  const ctx = await buildContext(opts);
  const results = await runChecks(ctx);
  const summary = { PASS: 0, FAIL: 0, WARN: 0, SKIP: 0 };
  for (const r of results) summary[r.status]++;
  const exitCode = summary.FAIL ? EXIT.FAIL : EXIT.OK;
  if (opts.json) {
    const { parcels, orderCols } = ctx.schema;
    console.log(JSON.stringify({
      tool: 'verify-attribution', version: 2, ref: REF, read_only: true,
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
