/**
 * repair-kit — the shared protocol for the Phase-2 money repairs (Macedonian CRM).
 *
 * Plan: C:\Users\Mile\.claude\plans\revert-the-421-unproven-encapsulated-brook.md, approved
 * 2026-09-27. Used by:
 *   scripts/repair-mex-ghost-links.mjs        (B — run FIRST)
 *   scripts/repair-altercpa-catchup-paid.mjs  (A — run after B)
 *   scripts/report-cod-mismatch.mjs           (C — read-only)
 *   scripts/repair-cod-price.mjs              (owner 28.09: CRM price := MEX COD)
 *   scripts/repair-test-phones.mjs            (owner 28.09: delete the test phones' orders)
 *   scripts/rollback-repair.mjs               (undo one applied run)
 *
 * BULK-WRITE GUARDS (owner rules 28.09, HANDOFF §1): every write transaction also sets
 *   SET LOCAL elyon.keep_updated_at = 'on'  — GET /call-agains reads orders.updated_at as
 *   last_call_at, so a repair must never look like a call (the update_updated_at_column()
 *   guard lands with 20260939000300; requireKeepUpdatedAt() refuses an apply without it).
 * An apply runs in the quiet window (after 20:55 Skopje, requireQuietWindow) and refuses to
 * start — and to start any further chunk (applyChunked) — while recompute_all_segments or
 * the 7-day rule (apply_no_parcel_rule, 21:10 Skopje) is running (requireNoSegmentRecompute;
 * the recompute deadlocked a repair once). SET session_replication_role is never used.
 *
 * THE PROTOCOL every repair follows:
 *   dry run (default)   classify → CSV in exports/repairs/<key>-<ts>.csv (PII, gitignored) →
 *                       compare counts with the expected ones (±2 %, never tighter than ±1
 *                       row) → record a data_repair_runs row (dry_run = true, candidate_hash
 *                       = sha256 of the sorted "order_id:rule:target:tracking" lines) → print
 *                       the run id.
 *   --apply --run <id>  re-classify; refuse unless the hash equals that run's (a resumed run
 *                       hashes its already-applied rows from the ledger + the re-classified
 *                       rest); then ≤ 200-order transactions (one implicit transaction per
 *                       API call — see buildChunkSql), each:
 *                         SET LOCAL elyon.bulk_repair = 'on' (no paid/returned alerts, no
 *                         AlterCPA confirm-rate trigger), lock the orders, keep only units still
 *                         in their planned state, data_repair_rows.before, status-guarded
 *                         UPDATEs, register unlinks, mex_link_parcel, order_history, one
 *                         order_notes row per order, data_repair_rows.after — COMMIT.
 *                       Then applied_at/applied_by on the run and one audit_log row.
 *
 * 🛑 MACEDONIA ONLY. The project ref is hard-coded; config.toml must agree and neither
 * config.toml nor .env may mention the live Bulgarian ref. The access token in .env can
 * write to Bulgaria too — nothing but these guards stops it. The token is never printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const MK_REF = 'bmfxhgznttcnnlqloqzp';
const BG_REF = 'sxymaloycddnoxudxaqp'; // live Bulgaria — never a target, never touched

/** FROZEN — see src/lib/currency.ts. The denar is derived; never "update" this. */
export const MKD_PER_EUR = 61.5;
/** MEX adds the 150 ден delivery fee to some CODs. */
export const DELIVERY_MKD = 150;
export const COD_TOLERANCE_MKD = 3;
export const DAY_MS = 86_400_000;
export const MAX_CHUNK = 200;
export const EXPORT_DIR = join(ROOT, 'exports', 'repairs');
/** Placeholder a plan uses for "the transaction's now()" in a timestamp column. */
export const NOW = '__now__';

// ─── console ────────────────────────────────────────────────────────────────
const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
export const red = paint(31);
export const green = paint(32);
export const yellow = paint(33);
export const bold = paint(1);
export function die(msg) {
  console.error(red(`✗ ${msg}`));
  process.exit(1);
}
export const warn = (m) => console.warn(yellow(`! ${m}`));
export const ok = (m) => console.log(`${green('✓')} ${m}`);

// ─── guard + Management API ─────────────────────────────────────────────────
let TOKEN = null;

/**
 * Refuse to run anywhere but Macedonia. Reads SUPABASE_ACCESS_TOKEN (process env first,
 * then .env). Never prints it.
 */
export function mkGuard() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (ref !== MK_REF) die(`supabase/config.toml project_id = "${ref}", expected "${MK_REF}" — refusing.`);
  if (toml.includes(BG_REF)) die('supabase/config.toml mentions the LIVE BULGARIAN project — refusing.');

  let envText = '';
  try { envText = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* .env optional if exported */ }
  if (envText.includes(BG_REF)) die('.env mentions the LIVE BULGARIAN project — refusing.');
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    const v = process.env[k] || env[k];
    if (v && v.includes(BG_REF)) die(`${k} points at LIVE BULGARIA — refusing.`);
    if (v && !v.includes(MK_REF)) die(`${k} does not point at ${MK_REF} — refusing.`);
  }
  TOKEN = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN || null;
  if (!TOKEN) die('SUPABASE_ACCESS_TOKEN missing (set it in .env).');
}

/**
 * Run SQL through the Management API (the same path as scripts/apply-migration-mk.mjs).
 * Returns the LAST non-empty result set of a multi-statement query. `readOnly` runs as
 * supabase_read_only_user (bypasses RLS, cannot write) — every loader uses it. Only reads
 * are retried: a write that timed out may have committed, and the ledger decides that.
 */
export async function sql(query, { readOnly = false } = {}) {
  if (!TOKEN) die('internal: mkGuard() must run before sql().');
  const attempts = readOnly ? 3 : 1;
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/database/query`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
      });
      const text = await res.text();
      if (!res.ok) {
        const err = new Error(`Management API ${res.status}: ${text.slice(0, 200000)}`);
        err.status = res.status;
        throw err;
      }
      if (!text) return [];
      const json = JSON.parse(text);
      return Array.isArray(json) ? json : [];
    } catch (e) {
      lastErr = e;
      const transient = !e.status || e.status >= 500 || e.status === 429;
      if (i < attempts && transient) {
        await new Promise((r) => setTimeout(r, 1500 * i));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
export const sqlRead = (query) => sql(query, { readOnly: true });

/** Second net: the remote must look like Macedonia (+389), not Bulgaria (+359). */
export async function assertRemoteIsMk() {
  const [r] = await sqlRead(`select (select count(*) from public.orders)::int as n,
    (select count(*) from public.orders where customer_phone like '+359%')::int as bg`);
  if (!r || !r.n) die('The remote has no orders — this is not the Macedonian CRM.');
  if (r.bg / r.n > 0.2) die(`The remote has ${r.bg}/${r.n} orders on +359 phones — this looks like LIVE BULGARIA.`);
  ok(`remote ${MK_REF} — ${r.n.toLocaleString('de-DE')} orders, ${r.bg} on +359`);
}

// ─── SQL literals (every value that reaches SQL goes through these) ─────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v) => UUID_RE.test(String(v ?? ''));
export function q(v) {
  if (v === null || v === undefined) return 'NULL';
  return `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`;
}
export function qUuid(v) {
  if (v === null || v === undefined) return 'NULL::uuid';
  if (!isUuid(v)) throw new Error(`not a uuid: ${String(v).slice(0, 60)}`);
  return `'${String(v).toLowerCase()}'::uuid`;
}
export const qJson = (v) => `${q(JSON.stringify(v ?? null))}::jsonb`;
export const qBool = (v) => (v ? 'true' : 'false');
export const qUuidArray = (ids) => (ids.length ? `ARRAY[${ids.map(qUuid).join(',')}]` : 'ARRAY[]::uuid[]');
export const qTextArray = (xs) => (xs.length ? `ARRAY[${xs.map(q).join(',')}]::text[]` : 'ARRAY[]::text[]');

// ─── domain helpers (pure) ──────────────────────────────────────────────────
/** Last 8 digits — the project's phone identity (last-8 matching). */
export const phone8 = (x) => String(x ?? '').replace(/\D/g, '').slice(-8);
export const toMs = (v) => (v === null || v === undefined || v === '' ? null : new Date(v).getTime());
export const isoOrNull = (v) => (v === null || v === undefined || v === '' ? null : new Date(v).toISOString());
/** Order price is stored in EUR; the COD MEX collects is denari at the frozen rate. */
export const expectedCodMkd = (priceEur) => Math.round(Number(priceEur || 0) * MKD_PER_EUR);

/**
 * Does a COD fit an order price? 'exact' (±3 ден), 'plus_delivery' (+150 ±3), or false.
 * A zero/absent price never fits — the same rule mex-reconcile uses.
 */
export function codFit(priceEur, codMkd) {
  const exp = expectedCodMkd(priceEur);
  const cod = Number(codMkd);
  if (!exp || !Number.isFinite(cod)) return false;
  if (Math.abs(cod - exp) <= COD_TOLERANCE_MKD) return 'exact';
  if (Math.abs(cod - exp - DELIVERY_MKD) <= COD_TOLERANCE_MKD) return 'plus_delivery';
  return false;
}

/** Mirror of src/lib/utils.ts isSyntheticProductName — keep the two in step. */
export function isSyntheticProductName(name) {
  const n = String(name ?? '').trim();
  if (!n || n === '—') return true;
  return /^(Cancelled|Trashed|No prior product on file)/i.test(n);
}

// Name + city matching — ported EXACTLY from the owner review builder (build-review.mjs,
// 2026-09-27) so the repair finds the same "другo телефон" parcels Mile approved.
const CYR = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', ѓ: 'g', е: 'e', ж: 'z', з: 'z', ѕ: 'dz', и: 'i', ј: 'j',
  к: 'k', л: 'l', љ: 'lj', м: 'm', н: 'n', њ: 'nj', о: 'o', п: 'p', р: 'r', с: 's', т: 't', ќ: 'k',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'c', џ: 'dz', ш: 's',
};
export const fold = (s) => String(s || '').toLowerCase().split('').map((ch) => CYR[ch] ?? ch).join('')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/zh/g, 'z').replace(/sh/g, 's').replace(/ch/g, 'c')
  .replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
export const nameTokens = (s) => fold(s).split(' ').filter((t) => t.length >= 3);
/** Levenshtein distance — the review's `ed`. */
export function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[a.length][b.length];
}
/** Same boolean as editDistance(a, b) <= 1, without the full matrix (the scan is large). */
function withinOneEdit(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++;
    else if (lb > la) j++;
    else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}
/** How many of the ORDER's name tokens appear in the parcel's (exact, or ≤ 1 edit when ≥ 5 chars). */
export function nameSimTokens(orderTokens, parcelTokens) {
  let m = 0;
  for (const a of orderTokens) {
    if (parcelTokens.some((b) => a === b || (a.length >= 5 && withinOneEdit(a, b)))) m++;
  }
  return m;
}
export const nameSim = (orderName, parcelName) => nameSimTokens(nameTokens(orderName), nameTokens(parcelName));
/** City prefix check — an empty city on either side passes (as in the review). */
export function cityOkFolded(a, b) {
  return !a || !b || a.startsWith(b.slice(0, 4)) || b.startsWith(a.slice(0, 4));
}
export const cityOk = (x, y) => cityOkFolded(fold(x), fold(y));

// ─── formatting ─────────────────────────────────────────────────────────────
export const fmtMkd = (n) => Math.round(Number(n) || 0).toLocaleString('de-DE');
const SKOPJE_DT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const SKOPJE_D = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', day: '2-digit', month: '2-digit', year: 'numeric' });
/** "27.09.2026 21:05" in Skopje time. */
export const fmtSkopje = (v) => (v == null || v === '' ? '' : SKOPJE_DT.format(new Date(v)).replace(/\//g, '.').replace(',', ''));
/** "27.09.2026" in Skopje time. */
export const fmtSkopjeDate = (v) => (v == null || v === '' ? '' : SKOPJE_D.format(new Date(v)).replace(/\//g, '.'));
export const skopjeHour = (v) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', hour12: false }).format(new Date(v))) % 24;
export const fileStamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// ─── CSV (UTF-8 with BOM so Excel shows Cyrillic) ────────────────────────────
export function writeCsv(fileName, rows, columns) {
  mkdirSync(EXPORT_DIR, { recursive: true });
  const cols = columns || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [cols.map(cell).join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  const path = join(EXPORT_DIR, fileName);
  writeFileSync(path, `\uFEFF${body}\r\n`, 'utf8');
  return path;
}

// ─── plan lines + hash ──────────────────────────────────────────────────────
/** One classified row → "order_id:rule:target:tracking" — what the hash covers. */
export const planLine = (orderId, rule, target, tracking) => `${orderId}:${rule}:${target ?? ''}:${tracking ?? ''}`;
export const lineOrderId = (line) => String(line).split(':')[0];
export const candidateHash = (lines) => createHash('sha256').update([...lines].sort().join('\n')).digest('hex');

// ─── CLI ────────────────────────────────────────────────────────────────────
/**
 * --flag and --key value / --key=value. Unknown flags are refused (a typo must never
 * silently turn an --apply into something else).
 */
export function parseArgs(argv, { flags = [], values = [] } = {}) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (flags.includes(k)) { out[k] = true; continue; }
    if (values.includes(k)) {
      const v = inline !== undefined ? inline : argv[++i];
      if (v === undefined || v.startsWith('--')) die(`--${k} needs a value`);
      out[k] = v;
      continue;
    }
    die(`unknown option --${k}`);
  }
  return out;
}

/** "--expect total=178,B2=70" over the documented defaults. */
export function parseExpect(str, defaults) {
  const exp = { ...defaults };
  if (!str) return exp;
  for (const part of String(str).split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    if (!k || v === undefined || !/^\d+$/.test(v)) die(`--expect: bad entry "${part}" (use key=number,key=number)`);
    if (!(k in defaults)) die(`--expect: unknown bucket "${k}" (known: ${Object.keys(defaults).join(', ')})`);
    exp[k] = Number(v);
  }
  return exp;
}

/** ±2 % of the expected count, never tighter than ±1 row. */
export function checkDrift(actual, expected) {
  const rows = [];
  let pass = true;
  for (const [bucket, exp] of Object.entries(expected)) {
    const act = actual[bucket] ?? 0;
    const tol = Math.max(1, Math.ceil(Math.abs(exp) * 0.02));
    const good = Math.abs(act - exp) <= tol;
    if (!good) pass = false;
    rows.push({ bucket, expected: exp, actual: act, tolerance: `±${tol}`, check: good ? 'ok' : 'DRIFT' });
  }
  return { pass, rows };
}
export const expectString = (counts, keys) => keys.map((k) => `${k}=${counts[k] ?? 0}`).join(',');

// ─── schema preconditions ───────────────────────────────────────────────────
/**
 * Everything the repairs write through is created by the pending Phase-1 migrations
 * (mex_parcel_register + money_guards). Fail loudly and early if they are not applied.
 */
export async function requireRepairSchema({ forApply = false, needReason = null } = {}) {
  const [s] = await sqlRead(`select
      to_regclass('public.mex_parcels') is not null as mex_parcels,
      to_regclass('public.data_repair_runs') is not null as runs,
      to_regclass('public.data_repair_rows') is not null as rows,
      to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)') is not null as link_fn,
      (select count(*)::int from information_schema.columns where table_schema = 'public' and table_name = 'orders'
         and column_name in ('paid_basis','mex_account','mex_status_id','mex_cod_mkd','mex_delivered_at','mex_returned_at','mex_last_update_at')) as order_cols,
      (select string_agg(pg_get_constraintdef(c.oid), ' | ') from pg_constraint c
        where c.conrelid = 'public.orders'::regclass and c.contype = 'c'
          and pg_get_constraintdef(c.oid) ilike '%cancellation_reason%') as reason_checks`);
  const missing = [];
  if (!s.mex_parcels) missing.push('table mex_parcels');
  if (!s.runs) missing.push('table data_repair_runs');
  if (!s.rows) missing.push('table data_repair_rows');
  if (!s.link_fn) missing.push('function mex_link_parcel(text,uuid,text,boolean)');
  if (s.order_cols < 7) missing.push(`orders MEX/paid_basis columns (${s.order_cols}/7 present)`);
  if (needReason && s.reason_checks && !String(s.reason_checks).includes(`'${needReason}'`)) {
    missing.push(`cancellation_reason value '${needReason}' (the orders CHECK does not allow it yet)`);
  }
  if (missing.length) {
    die(`The Phase-1 migrations are not applied yet — missing: ${missing.join('; ')}.\n` +
      '  Apply …_mex_parcel_register.sql and …_money_guards.sql, run scripts/backfill-mex-register.mjs, then retry.');
  }

  // The bulk-repair switch must actually silence the notification + confirm-rate triggers,
  // or an apply floods every admin's bell with hundreds of paid/returned alerts.
  const trg = await sqlRead(`select t.tgname, p.proname, position('bulk_repair' in p.prosrc) > 0 as honours_guc
    from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = 'public.orders'::regclass and not t.tgisinternal
      and t.tgname in ('trg_notify_order_paid','trg_notify_order_returned','trg_altercpa_confirm_rate')`);
  const deaf = trg.filter((t) => !t.honours_guc).map((t) => `${t.tgname} → ${t.proname}()`);
  if (deaf.length) {
    const msg = `elyon.bulk_repair is not honoured by: ${deaf.join(', ')} (money_guards migration not applied?)`;
    if (forApply) die(msg);
    warn(`${msg} — fine for a dry run, BLOCKS --apply.`);
  }
}

// ─── bulk-write guards (owner rules 28.09) ───────────────────────────────────
/**
 * The update_updated_at_column() guard must be live before any bulk write: without it
 * SET LOCAL elyon.keep_updated_at = 'on' is a no-op and every repaired order's updated_at
 * jumps to now() — which GET /call-agains reads as its last call. Refuses an --apply,
 * warns on a dry run. The check is the one the handoff names: the function's source
 * must mention keep_updated_at (migration 20260939000300).
 */
export async function requireKeepUpdatedAt({ forApply = false } = {}) {
  const rows = await sqlRead(`select n.nspname as schema, p.prosrc from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace where p.proname = 'update_updated_at_column'`);
  const pub = rows.find((r) => r.schema === 'public');
  const okGuard = !!pub && keepUpdatedAtGuarded(pub.prosrc);
  if (okGuard) { ok('update_updated_at_column() honours elyon.keep_updated_at'); return true; }
  const msg = pub
    ? 'public.update_updated_at_column() does not honour elyon.keep_updated_at — apply migration 20260939000300 first'
    : 'public.update_updated_at_column() not found';
  if (forApply) die(`${msg}. Refusing to write: every repaired order would get updated_at = now(), which /call-agains reads as a call.`);
  warn(`${msg} — fine for a dry run, BLOCKS --apply.`);
  return false;
}
/** Pure: does a function body honour the keep_updated_at switch? */
export const keepUpdatedAtGuarded = (prosrc) => String(prosrc ?? '').includes('keep_updated_at');

/** Quiet window for bulk writes: 20:55 → 07:00 Skopje (HANDOFF §1). */
export const QUIET_FROM_MIN = 20 * 60 + 55;
export const QUIET_TO_MIN = 7 * 60;
export function skopjeMinuteOfDay(ms = Date.now()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}
export const inQuietWindow = (ms = Date.now()) => {
  const m = skopjeMinuteOfDay(ms);
  return m >= QUIET_FROM_MIN || m < QUIET_TO_MIN;
};
/**
 * Refuse an apply outside the quiet window unless the operator says so explicitly
 * (the override is printed and belongs in the run's audit payload).
 */
export function requireQuietWindow({ override = false, ms = Date.now() } = {}) {
  if (inQuietWindow(ms)) { ok(`inside the quiet window (${fmtSkopje(ms)} Skopje, 20:55–07:00)`); return true; }
  if (override) { warn(`OUTSIDE the quiet window (${fmtSkopje(ms)} Skopje) — proceeding because --outside-quiet-window was given.`); return false; }
  die(`It is ${fmtSkopje(ms)} Skopje — bulk writes run in the quiet window after 20:55 (until 07:00).\n` +
    '  Re-run then, or pass --outside-quiet-window if this really cannot wait.');
  return false;
}

/**
 * The bulk writers a repair must never run beside: public.recompute_all_segments() locks
 * segment members per phone while reading orders (a repair holding order rows deadlocked
 * against it once — HANDOFF §1), and public.apply_no_parcel_rule() — the 7-day rule, 21:10
 * Skopje, i.e. inside the quiet window — cancels orders in bulk.
 */
export const BUSY_FUNCTIONS = Object.freeze(['recompute_all_segments', 'apply_no_parcel_rule']);
/** The pg_stat_activity probe (pure string — tested against a real database). */
export const busyActivitySql = () => {
  const any = BUSY_FUNCTIONS.map((f) => `query ilike '%${f}%'`).join(' or ');
  return `select
      count(*) filter (where ${any})::int as busy,
      coalesce(string_agg(distinct case ${BUSY_FUNCTIONS.map((f) => `when query ilike '%${f}%' then '${f}'`).join(' ')} end, ', '), '') as what,
      count(*) filter (where query = '<insufficient privilege>')::int as hidden,
      coalesce(max(extract(epoch from now() - query_start)) filter (where ${any}), 0)::int as busy_for_s
    from pg_stat_activity
   where pid <> pg_backend_pid() and state is distinct from 'idle'`;
};
/**
 * Is one of BUSY_FUNCTIONS running right now? Runs on the privileged path so every session's
 * query text is visible; a session hiding its text is reported.
 */
export async function segmentRecomputeActivity() {
  const [r] = await sql(busyActivitySql());
  return r || { busy: 0, what: '', hidden: 0, busy_for_s: 0 };
}
/** Die (before a write) while the segment recompute — or the 7-day rule — runs. */
export async function requireNoSegmentRecompute(where = 'start') {
  const a = await segmentRecomputeActivity();
  if (a.busy > 0) {
    die(`${a.what || 'recompute_all_segments'} is running (${a.busy} session(s), ${a.busy_for_s} s so far) — refusing to ${where}.\n` +
      '  Wait for it to finish, then re-run the same command (an interrupted apply resumes from the ledger).');
  }
  if (a.hidden > 0) warn(`${a.hidden} session(s) in pg_stat_activity hide their query text from this role — could not rule out a recompute there.`);
  ok('neither recompute_all_segments nor the 7-day rule is running');
  return a;
}

/** orders column → SQL type name (format_type) for the columns a plan may write. */
export async function loadOrderColumnTypes() {
  const rows = await sqlRead(`select a.attname as col, format_type(a.atttypid, a.atttypmod) as typ
    from pg_attribute a where a.attrelid = 'public.orders'::regclass and a.attnum > 0 and not a.attisdropped`);
  return Object.fromEntries(rows.map((r) => [r.col, r.typ]));
}

// ─── people ─────────────────────────────────────────────────────────────────
/** The human the apply is recorded under (audit_log.actor_id is NOT NULL). */
export async function resolveActor(email) {
  const rows = await sqlRead(`select id, email from auth.users where lower(email) = lower(${q(email)}) limit 2`);
  if (rows.length !== 1) die(`--actor ${email}: no single auth user with that email.`);
  return { id: rows[0].id, email: rows[0].email };
}

/** Orders that sit in an agent payout — never touched automatically, listed instead. */
export async function loadPayoutOrderIds(orderIds) {
  const out = new Set();
  const ids = [...new Set(orderIds)].filter(isUuid);
  for (let i = 0; i < ids.length; i += 1000) {
    const rows = await sqlRead(`select distinct order_id from public.agent_payout_items where order_id = any(${qUuidArray(ids.slice(i, i + 1000))})`);
    for (const r of rows) out.add(r.order_id);
  }
  return out;
}

// ─── MEX decides money: parcel status → order status ────────────────────────
export const MEX_ACTOR = 'System (mex:reconciliation)';
const OPEN_FOR_SHIP = new Set(['pending', 'call_again', 'confirmed']);

/**
 * The status a parcel implies for an order, or null when nothing should change. Same law as
 * mex-reconcile: 2 Delivered → paid, 7 Returned → returned, any other status → shipped but
 * only forward from an open status (never over a terminal one). `take` (an agent has it
 * open) and `duplicated` are never touched. Never returns 'confirmed'.
 */
export function mexTargetFor(status, parcel) {
  if (!parcel || status === 'take' || status === 'duplicated') return null;
  const s = Number(parcel.status_id);
  if (s === 2) return status === 'paid' ? null : 'paid';
  if (s === 7) return status === 'returned' ? null : 'returned';
  return OPEN_FOR_SHIP.has(status) ? 'shipped' : null;
}

/** Columns that put an order into `target` from parcel `p` (disposition fields cleared, as mex-reconcile does). */
export function mexStatusSet(target, p) {
  const cleared = {
    cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
    trash_reason: null, trash_reason_notes: null, trashed_at: null,
  };
  if (target === 'paid') return { ...cleared, status: 'paid', paid_at: isoOrNull(p.delivered_at ?? p.last_update_at ?? p.created_at_mex) ?? NOW, returned_at: null, paid_basis: 'mex' };
  if (target === 'returned') return { ...cleared, status: 'returned', returned_at: isoOrNull(p.returned_at ?? p.last_update_at) ?? NOW, paid_at: null, paid_basis: null };
  if (target === 'shipped') return { ...cleared, status: 'shipped', shipped_at: isoOrNull(p.created_at_mex) ?? NOW, paid_at: null, paid_basis: null };
  throw new Error(`no MEX status set for ${target}`);
}
export const parcelWord = (p) => (Number(p?.status_id) === 2 ? 'delivered' : Number(p?.status_id) === 7 ? 'returned' : `${p?.status_name || 'with the courier'}`);

/** order_history rows (oldest first) for the given orders. */
export async function loadHistory(orderIds) {
  const ids = [...new Set(orderIds)].filter(isUuid);
  const out = [];
  for (let i = 0; i < ids.length; i += 1000) {
    out.push(...await sqlRead(`select order_id, from_status::text as from_status, to_status::text as to_status,
        changed_by, changed_by_name, changed_at
      from public.order_history where order_id = any(${qUuidArray(ids.slice(i, i + 1000))}) order by changed_at, id`));
  }
  return out;
}

/** The MEX reconcile's own notes ("MEX <tracking> delivered … — status corrected to paid"). */
export async function loadMexNotes(orderIds) {
  const ids = [...new Set(orderIds)].filter(isUuid);
  const out = [];
  for (let i = 0; i < ids.length; i += 1000) {
    out.push(...await sqlRead(`select order_id, created_at, text from public.order_notes
      where order_id = any(${qUuidArray(ids.slice(i, i + 1000))}) and text like 'MEX %' order by created_at`));
  }
  return out;
}

/**
 * Was this order's current paid/returned/shipped status set by the MEX reconcile flipping it
 * out of a cancel/trash — via THIS parcel (its own note names the tracking id) — with nobody
 * else changing it since? Then it can go back. Returns { ok, revertTo, flip, originAt,
 * soldBefore } or { ok: false, why }.
 *   originAt   when it originally became cancelled/trashed (a person's history row), else
 *              created_at — the true order date for imported leads (sticky-trash skill).
 *   soldBefore it was confirmed/shipped/paid at some point BEFORE that flip.
 */
export function mexFlipRevert({ order, history, notes, tracking }) {
  if (!['paid', 'returned', 'shipped'].includes(order.status)) return { ok: false, why: `status is ${order.status}` };
  const rows = history.filter((h) => h.order_id === order.id);
  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].changed_by_name === MEX_ACTOR && ['cancelled', 'trashed'].includes(rows[i].from_status)) { idx = i; break; }
  }
  if (idx < 0) return { ok: false, why: `its ${order.status} did not come from the MEX reconcile flipping a cancel/trash` };
  const later = rows.slice(idx + 1).find((h) => h.changed_by_name !== MEX_ACTOR);
  if (later) return { ok: false, why: `changed by ${later.changed_by_name || 'someone'} after the MEX flip` };
  if (rows[rows.length - 1].to_status !== order.status) return { ok: false, why: 'its history does not end in the current status' };
  if (tracking && !notes.some((n) => n.order_id === order.id && String(n.text).includes(tracking))) {
    return { ok: false, why: `no MEX note ties its flip to ${tracking}` };
  }
  const flip = rows[idx];
  const before = rows.slice(0, idx);
  const origin = [...before].reverse().find((h) => h.to_status === flip.from_status && h.changed_by);
  const soldBefore = before.some((h) => ['confirmed', 'shipped', 'delivered', 'paid'].includes(h.to_status)) || !!order.confirmed_at;
  return { ok: true, revertTo: flip.from_status, flip, originAt: origin?.changed_at ?? order.created_at, soldBefore };
}

/**
 * Owner decision 2026-09-27: a restored TRASH is 'not_reachable' — the 21-day PARKED class,
 * timed from the original disposition — never the permanent 'other'. A restored CANCEL reads
 * 'other' (cancel reasons carry no permanence).
 */
export function trashParkNote(tracking, parcel) {
  const why = Number(parcel?.status_id) === 2 ? 'MEX delivered+paid' : `MEX parcel ${parcelWord(parcel)}`;
  return `original trash reason was wiped by a mis-matched MEX parcel${tracking ? ` (${tracking})` : ''}; restored as not_reachable (21-day park)` +
    ` because the customer demonstrably ${Number(parcel?.status_id) === 2 ? 'bought' : 'ordered'} via another channel (${why}) — owner decision 2026-09-27`;
}

/** Columns that put a MEX-flipped order back to its cancel/trash, parcel link and money cleared. */
export function revertDispositionSet({ revertTo, at, cancelNote, trashNote }) {
  const isCancel = revertTo === 'cancelled';
  if (!isCancel && revertTo !== 'trashed') throw new Error(`cannot revert to ${revertTo}`);
  return {
    status: revertTo,
    cancelled_at: isCancel ? isoOrNull(at) : null,
    cancellation_reason: isCancel ? 'other' : null,
    cancellation_reason_notes: isCancel ? cancelNote : null,
    trashed_at: isCancel ? null : isoOrNull(at),
    trash_reason: isCancel ? null : 'not_reachable',
    trash_reason_notes: isCancel ? null : trashNote,
    paid_at: null, returned_at: null, shipped_at: null,
    mex_tracking_id: null, mex_account: null, mex_status_id: null, mex_cod_mkd: null,
    mex_delivered_at: null, mex_returned_at: null, mex_last_update_at: null,
    paid_basis: null,
  };
}

// ─── sticky Trash pre-check (mirror of recompute_customer_segments, engine v3.7-mk) ─────
/**
 * Every order on the given EXACT phones (the engine keys on customer_phone, not last-8).
 */
export async function loadPhoneOrders(phones) {
  const list = [...new Set(phones.filter(Boolean))];
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    out.push(...await sqlRead(`select id, display_id, customer_phone, status::text as status, created_at,
        trashed_at, trash_reason, source_type
      from public.orders where customer_phone = any(${qTextArray(list.slice(i, i + 500))})`));
  }
  return out;
}

function trashState(rows, nowMs) {
  const live = rows.filter((r) => r.source_type !== 'monadon_legacy');
  let lastPaid = null, perm = null, permRow = null, unreach = null;
  for (const r of live) {
    const created = toMs(r.created_at);
    if (r.status === 'paid' && (lastPaid === null || created > lastPaid)) lastPaid = created;
    if (r.status === 'trashed') {
      const at = toMs(r.trashed_at) ?? created;
      if (r.trash_reason === 'not_reachable') { if (unreach === null || at > unreach) unreach = at; }
      else if (r.trash_reason !== 'duplicate_order') { if (perm === null || at > perm) { perm = at; permRow = r; } }
    }
  }
  const permTrashed = perm !== null && (lastPaid === null || lastPaid <= perm);
  const parked = !permTrashed && unreach !== null && nowMs - unreach < 21 * DAY_MS && (lastPaid === null || lastPaid <= unreach);
  if (permTrashed) return { kind: 'permanent', by: permRow ? `${permRow.display_id} (${permRow.trash_reason || 'no reason'})` : '', reason: permRow?.trash_reason || 'no reason' };
  if (parked) return { kind: 'parked', until: unreach + 21 * DAY_MS };
  return null;
}

/**
 * Which customers fall INTO sticky Trash (or are released from it) once the planned
 * status changes land. A paid order dated after a trash is the ONLY release (MK rule,
 * 2026-08-06), so taking a customer's only post-trash "paid" away puts them back.
 * `changes`: Map orderId → { status, trashed_at?, trash_reason? } (the after-state).
 * falls[].kind: 'permanent' (held until a new paid order) or 'parked' (not_reachable,
 * released by itself at falls[].until). Listed, never blocking.
 */
export function stickyTrashEffects(phoneOrders, changes, nowMs = Date.now()) {
  const byPhone = new Map();
  for (const r of phoneOrders) (byPhone.get(r.customer_phone) ?? byPhone.set(r.customer_phone, []).get(r.customer_phone)).push(r);
  const falls = [], released = [];
  for (const [phone, rows] of byPhone) {
    if (!rows.some((r) => changes.has(r.id))) continue;
    const after = rows.map((r) => (changes.has(r.id) ? { ...r, ...changes.get(r.id) } : r));
    const was = trashState(rows, nowMs), will = trashState(after, nowMs);
    const touched = rows.filter((r) => changes.has(r.id)).map((r) => r.display_id);
    if (!was && will) falls.push({ phone, orders: touched, kind: will.kind, until: will.until ?? null, by: will.by || '', reason: will.reason || '' });
    else if (was?.kind === 'parked' && will?.kind === 'permanent') falls.push({ phone, orders: touched, kind: 'permanent', until: null, by: will.by || '', reason: will.reason || '' });
    if (was && !will) released.push({ phone, orders: touched });
  }
  return { falls, released };
}

/** Print the sticky-Trash pre-check: permanent re-trashes first (the ones that matter). */
export function printTrashFalls(trash, label = 'customers who fall back into sticky Trash') {
  const perm = trash.falls.filter((f) => f.kind === 'permanent');
  const parked = trash.falls.filter((f) => f.kind === 'parked');
  console.log(`  ${label}: ${perm.length} permanent · ${parked.length} parked (not_reachable, release by themselves)`);
  if (perm.length) {
    const byReason = {};
    for (const f of perm) byReason[f.reason || '?'] = (byReason[f.reason || '?'] || 0) + 1;
    console.log(`    permanent — held by an EXISTING trash, by its reason: ${Object.entries(byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => `${r} ×${n}`).join(', ')}`);
  }
  for (const f of perm.slice(0, 40)) console.log(`    PERMANENT  ${f.orders.join(', ')}  ← ${f.by}`);
  if (perm.length > 40) console.log(`    … ${perm.length - 40} more permanent in the CSV`);
  const byDay = {};
  for (const f of parked) { const d = fmtSkopjeDate(f.until); byDay[d] = (byDay[d] || 0) + 1; }
  if (parked.length) console.log(`    parked until: ${Object.entries(byDay).sort((a, b) => a[0].split('.').reverse().join('').localeCompare(b[0].split('.').reverse().join(''))).map(([d, n]) => `${d} ×${n}`).join(', ')}`);
  return { permanent: perm.length, parked: parked.length };
}

// ─── the run ledger ─────────────────────────────────────────────────────────
/** JSON with object keys sorted at every level — jsonb does not keep the insertion order. */
export function canonicalJson(v) {
  const norm = (x) => (Array.isArray(x) ? x.map(norm)
    : x && typeof x === 'object' ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, norm(x[k])])) : x);
  return JSON.stringify(norm(v));
}

export async function recordDryRun({ key, lines, summary }) {
  const id = randomUUID();
  const hash = candidateHash(lines);
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(id)}, ${q(key)}, true, ${q(hash)}, ${qJson({ ...summary, lines: lines.length })})`);
  return { id, hash };
}

/**
 * Everything an --apply must prove before it writes: the run exists, belongs to this
 * script, is not applied yet, and the classification still hashes to what was reviewed.
 * Rows a previous (interrupted) apply already committed are taken from the ledger —
 * their re-classification would legitimately differ, their planned line does not.
 */
export async function verifyRunForApply({ key, runId, lines, options = null }) {
  if (!isUuid(runId)) die('--run must be the data_repair_runs id printed by the dry run.');
  const [run] = await sqlRead(`select id, key, dry_run, candidate_hash, summary, created_at, applied_at
    from public.data_repair_runs where id = ${qUuid(runId)}`);
  if (!run) die(`run ${runId} not found.`);
  if (run.key !== key) die(`run ${runId} belongs to "${run.key}", not "${key}".`);
  if (!run.dry_run) die(`run ${runId} is not a dry run.`);
  if (run.applied_at) die(`run ${runId} was already applied at ${fmtSkopje(run.applied_at)}.`);
  if (options) {
    // canonical: jsonb hands the recorded object back with its keys re-ordered
    const recorded = canonicalJson(run.summary?.options ?? {});
    if (recorded !== canonicalJson(options)) die(`run ${runId} was dry-run with options ${recorded}; this apply uses ${canonicalJson(options)} — pass the same flags.`);
  }
  const doneRows = await sqlRead(`select order_id, evidence->>'line' as line from public.data_repair_rows
    where run_id = ${qUuid(runId)} and after is not null`);
  const done = new Set(doneRows.map((r) => r.order_id));
  const combined = [...doneRows.map((r) => r.line), ...lines.filter((l) => !done.has(lineOrderId(l)))];
  const hash = candidateHash(combined);
  if (hash !== run.candidate_hash) {
    die(`The candidate set changed since the dry run (hash ${hash.slice(0, 12)}… ≠ ${String(run.candidate_hash).slice(0, 12)}…).\n` +
      '  Run the dry run again, review the new CSV, and apply THAT run id.');
  }
  const ageH = (Date.now() - toMs(run.created_at)) / 3_600_000;
  if (ageH > 24) warn(`the dry run is ${ageH.toFixed(1)} h old — the hash still matches, so nothing changed.`);
  ok(`hash matches the dry run (${hash.slice(0, 12)}…)${done.size ? `; ${done.size} orders were already applied by an earlier attempt — resuming` : ''}`);
  return { run, done };
}

// ─── the apply engine ───────────────────────────────────────────────────────
/** Columns snapshotted before/after (and restored by rollback-repair.mjs). */
export const SNAP_COLUMNS = [
  'status', 'paid_at', 'returned_at', 'shipped_at', 'cancelled_at', 'trashed_at',
  'cancellation_reason', 'cancellation_reason_notes', 'trash_reason', 'trash_reason_notes',
  'mex_tracking_id', 'mex_account', 'mex_status_id', 'mex_cod_mkd', 'mex_delivered_at', 'mex_returned_at',
  'mex_last_update_at', 'paid_basis',
];

/**
 * jsonb snapshot of an order (alias `o`) + the register rows it touches: every parcel
 * linked to it, plus those `parcelWhere` (a predicate on `mp`) names.
 */
export function snapshotSql(o, parcelWhere) {
  const pairs = SNAP_COLUMNS.map((c) => `'${c}', ${o}.${c}`).join(', ');
  return `jsonb_build_object(${pairs}, 'parcels', coalesce((
      select jsonb_agg(jsonb_build_object('tracking_id', mp.tracking_id, 'order_id', mp.order_id,
                                          'link_method', mp.link_method, 'linked_at', mp.linked_at) order by mp.tracking_id)
      from public.mex_parcels mp
      where mp.order_id = ${o}.id or ${parcelWhere}), '[]'::jsonb))`;
}
/** The same snapshot without the register part — what "row still equals after" compares. */
export function orderSnapshotSql(o) {
  return `jsonb_build_object(${SNAP_COLUMNS.map((c) => `'${c}', ${o}.${c}`).join(', ')})`;
}

const KEY_RE = /^[a-z0-9-]+$/;

/**
 * A plan row (one order):
 *   { unit, order_id, rule, line, expect_status, expect_tracking,
 *     set: { column: value | NOW | null },    // only the columns this row changes
 *     link: { tracking, method, force, expectOwner } | null,  // mex_link_parcel after the UPDATEs
 *     unlink: tracking | [tracking] | null,   // register rows cleared if they still point here
 *     history: { from, to } | null, note, evidence }
 * `status` is only put in `set` when it really changes: its BEFORE triggers stamp
 * shipped/cancelled/returned/trashed/paid_at on every UPDATE OF status.
 * Rows sharing a `unit` are applied together or not at all.
 */
function chunkUnits(units, size) {
  const chunks = [];
  let cur = [], n = 0;
  for (const u of units) {
    if (u.rows.length > size) throw new Error(`unit ${u.unit} has ${u.rows.length} rows — larger than a chunk`);
    if (n + u.rows.length > size && cur.length) { chunks.push(cur); cur = []; n = 0; }
    cur.push(u); n += u.rows.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

/**
 * One chunk = ONE transaction. Deliberately written WITHOUT an explicit BEGIN/COMMIT: the
 * Management API sends the whole string as one simple-protocol Query, which PostgreSQL runs
 * as a single implicit transaction — SET LOCAL holds to its end (verified live 2026-09-27),
 * any error rolls the entire chunk back, and the connection is left clean. With an explicit
 * BEGIN an error would leave an aborted transaction (and its order-row locks) on the API's
 * connection until that connection is recycled.
 */
export function buildChunkSql({ key, runId, rows, typeMap }) {
  const actor = `System (repair:${key})`;
  const colExpr = (col) => {
    const t = typeMap[col];
    if (!t) throw new Error(`orders.${col} does not exist — is the migration applied?`);
    if (t === 'timestamp with time zone') {
      return `case when k.set_cols->>'${col}' = '${NOW}' then now() else (k.set_cols->>'${col}')::timestamptz end`;
    }
    return `(k.set_cols->>'${col}')::${t}`;
  };
  const values = rows.map((r) => {
    const shape = Object.keys(r.set || {}).sort().join(',');
    return `(${[
      q(r.unit), qUuid(r.order_id), q(r.rule), q(shape), q(r.expect_status), q(r.expect_tracking ?? null),
      qUuid(r.link?.expectOwner ?? null), qJson(r.set || {}),
      q(r.link?.tracking ?? null), q(r.link?.method ?? null), qBool(!!r.link?.force),
      qTextArray(r.unlink ? [].concat(r.unlink).filter(Boolean) : []), q(r.history?.from ?? null), q(r.history?.to ?? null),
      q(r.note ?? null), qJson({ ...(r.evidence || {}), line: r.line, unit: r.unit }),
    ].join(', ')})`;
  });
  const shapes = [...new Set(rows.map((r) => Object.keys(r.set || {}).sort().join(',')))].filter(Boolean);
  const updates = shapes.map((shape) => `
update public.orders o set ${shape.split(',').map((c) => `${c} = ${colExpr(c)}`).join(', ')}
  from _ok k
 where k.shape = ${q(shape)} and o.id = k.order_id and o.status::text = k.expect_status;`).join('\n');
  const parcelWhere = 'mp.tracking_id in (k.expect_tracking, k.link_tracking) or mp.tracking_id = any(k.unlink_trackings)';

  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _plan (
  unit text not null, order_id uuid primary key, rule text not null, shape text not null,
  expect_status text not null, expect_tracking text, link_expect_owner uuid, set_cols jsonb not null,
  link_tracking text, link_method text, link_force boolean not null,
  unlink_trackings text[] not null, hist_from text, hist_to text, note text, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

-- lock every order and parcel of the chunk; concurrent writers wait for the commit
select count(*) from (select 1 from public.orders where id in (select order_id from _plan) for update) l;
select count(*) from (select 1 from public.mex_parcels
  where tracking_id in (select link_tracking from _plan)
     or tracking_id in (select unnest(unlink_trackings) from _plan)
     or tracking_id in (select expect_tracking from _plan)
  for update) l;

-- only units whose every order (and every parcel it links) is still exactly as planned
create temp table _ok on commit drop as
select p.* from _plan p
 where not exists (
         select 1 from _plan x left join public.orders o on o.id = x.order_id
          where x.unit = p.unit
            and (o.id is null
                 or o.status::text is distinct from x.expect_status
                 or o.mex_tracking_id is distinct from x.expect_tracking))
   and not exists (
         select 1 from _plan x left join public.mex_parcels mp on mp.tracking_id = x.link_tracking
          where x.unit = p.unit and x.link_tracking is not null
            and (mp.tracking_id is null or mp.order_id is distinct from x.link_expect_owner));

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, k.order_id, k.rule, ${snapshotSql('o', parcelWhere)}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;
${updates}

do $chk$
declare n int;
begin
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id
   where jsonb_exists(k.set_cols, 'status') and o.status::text is distinct from k.set_cols->>'status';
  if n > 0 then raise exception 'repair: % orders did not reach their target status', n; end if;
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id where o.status = 'confirmed';
  if n > 0 then raise exception 'repair: % orders would sit in confirmed (the warehouse export queue)', n; end if;
end $chk$;

update public.mex_parcels mp set order_id = null, link_method = null, linked_at = null
  from _ok k
 where mp.tracking_id = any(k.unlink_trackings) and mp.order_id = k.order_id;

create temp table _links on commit drop as
select k.order_id, k.link_tracking,
       public.mex_link_parcel(k.link_tracking, k.order_id, k.link_method, k.link_force) as res
  from _ok k where k.link_tracking is not null order by k.order_id;

do $chk$
declare bad text;
begin
  select string_agg(link_tracking || ' → ' || coalesce(res, 'null'), ', ') into bad
    from _links where res is null or res not in ('linked', 'already');
  if bad is not null then raise exception 'repair: mex_link_parcel refused: %', bad; end if;
end $chk$;

insert into public.order_history (order_id, from_status, to_status, changed_by, changed_by_name)
select k.order_id, k.hist_from::public.order_status, k.hist_to::public.order_status, null, ${q(actor)}
  from _ok k where k.hist_to is not null;

insert into public.order_notes (order_id, text, author_id, author_name)
select k.order_id, k.note, null, ${q(actor)} from _ok k where k.note is not null;

update public.data_repair_rows r set after = ${snapshotSql('o', parcelWhere)}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select count(*) from _links)::int as links,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

/**
 * Apply the actionable units in ≤ `chunkSize`-order transactions. Stops at the first
 * failed chunk (it rolled back as a whole); already-committed chunks are in the ledger
 * and a re-run with the same --run resumes after them.
 */
export async function applyUnits({ key, runId, units, typeMap, chunkSize = MAX_CHUNK }) {
  if (!KEY_RE.test(key)) throw new Error(`bad repair key ${key}`);
  const size = Math.max(1, Math.min(MAX_CHUNK, Number(chunkSize) || MAX_CHUNK));
  const seen = new Set();
  for (const u of units) {
    for (const r of u.rows) {
      if (seen.has(r.order_id)) throw new Error(`order ${r.order_id} is planned twice — refusing`);
      seen.add(r.order_id);
      if (r.set && r.set.status === 'confirmed') throw new Error(`order ${r.order_id} would be set to confirmed — refusing`);
    }
  }
  const chunks = chunkUnits(units, size);
  const stats = { chunks: chunks.length, committed: 0, planned: 0, applied: 0, links: 0, skipped: [], failed: null };
  for (let i = 0; i < chunks.length; i++) {
    const rows = chunks[i].flatMap((u) => u.rows);
    const t0 = Date.now();
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${rows.length} orders) … `);
    try {
      const [res] = await sql(buildChunkSql({ key, runId, rows, typeMap }));
      if (!res) throw new Error('no result row came back — check the ledger before resuming');
      stats.committed++;
      stats.planned += res.planned;
      stats.applied += res.applied;
      stats.links += res.links;
      const skipped = Array.isArray(res.skipped) ? res.skipped : [];
      stats.skipped.push(...skipped);
      console.log(`${green('committed')} ${res.applied}/${res.planned}` +
        `${skipped.length ? yellow(` (${skipped.length} moved since the dry run — left alone)`) : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.log(red('FAILED — rolled back'));
      stats.failed = { chunk: i + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(red(stats.failed.error));
      break;
    }
  }
  return stats;
}

/**
 * The generic chunk loop for repairs that build their own transaction SQL (cod-price,
 * test-phones, their restores). `items` are split into ≤ `chunkSize` (≤ 200) groups; each
 * group is ONE API call = ONE implicit transaction (see buildChunkSql). Before every chunk the
 * segment recompute is checked again: if it started, the loop STOPS cleanly (committed chunks
 * stay in the ledger; the same command resumes). Stops at the first failed chunk.
 * build(chunk) → SQL whose last result row has { planned, applied, skipped? }.
 */
export async function applyChunked({ items, build, chunkSize = MAX_CHUNK, label = 'orders', checkRecompute = true }) {
  const size = Math.max(1, Math.min(MAX_CHUNK, Number(chunkSize) || MAX_CHUNK));
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const stats = { chunks: chunks.length, committed: 0, planned: 0, applied: 0, skipped: [], failed: null, results: [] };
  for (let i = 0; i < chunks.length; i++) {
    if (checkRecompute) {
      const a = await segmentRecomputeActivity();
      if (a.busy > 0) {
        stats.failed = { chunk: i + 1, error: `${a.what || 'recompute_all_segments'} started (${a.busy} session(s)) — stopped before this chunk` };
        console.log(yellow(`  stopped before chunk ${i + 1}/${chunks.length}: ${stats.failed.error}`));
        break;
      }
    }
    const t0 = Date.now();
    process.stdout.write(`  chunk ${i + 1}/${chunks.length} (${chunks[i].length} ${label}) … `);
    try {
      const [res] = await sql(build(chunks[i]));
      if (!res) throw new Error('no result row came back — check the ledger before resuming');
      stats.committed++;
      stats.planned += Number(res.planned ?? chunks[i].length);
      stats.applied += Number(res.applied ?? res.restored ?? 0);
      const skipped = Array.isArray(res.skipped) ? res.skipped : [];
      stats.skipped.push(...skipped);
      stats.results.push(res);
      console.log(`${green('committed')} ${res.applied ?? res.restored}/${res.planned ?? chunks[i].length}` +
        `${skipped.length ? yellow(` (${skipped.length} moved since the dry run — left alone)`) : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.log(red('FAILED — rolled back'));
      stats.failed = { chunk: i + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(red(stats.failed.error));
      break;
    }
  }
  return stats;
}

/** applied_at/applied_by + one audit_log row. Only called once every chunk committed. */
export async function finalizeRun({ key, runId, actor, payload }) {
  // two statements, one implicit transaction (see buildChunkSql)
  await sql(`update public.data_repair_runs
       set applied_at = now(), applied_by = ${qUuid(actor.id)},
           summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${qJson(payload)})
     where id = ${qUuid(runId)} and applied_at is null;
    insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(runId)}, ${q(key)}, ${qJson(payload)});`);
}

/** One audit row for an apply that stopped part-way (the ledger has the detail). */
export async function auditPartial({ key, runId, actor, payload }) {
  await sql(`insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
    values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply_partial', 'data_repair_run', ${q(runId)}, ${q(key)}, ${qJson(payload)})`);
}

/**
 * Read-only info for the apply banner: when the edge functions that must carry the
 * Phase-1 guards were last deployed. Never fatal.
 */
export async function edgeFunctionInfo(slugs) {
  const out = {};
  for (const slug of slugs) {
    try {
      const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/functions/${slug}`, {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      if (!res.ok) { out[slug] = `unknown (${res.status})`; continue; }
      const j = await res.json();
      const ts = j.updated_at ? (typeof j.updated_at === 'number' ? new Date(j.updated_at) : new Date(j.updated_at)) : null;
      out[slug] = `v${j.version ?? '?'}${ts && !Number.isNaN(ts.getTime()) ? `, deployed ${fmtSkopje(ts)}` : ''}`;
    } catch (e) {
      out[slug] = `unknown (${String(e.message || e).slice(0, 60)})`;
    }
  }
  return out;
}

export function printTable(rows) {
  if (rows.length) console.table(rows);
}

/** Counts + денари per rule for the summary. */
export function tally(rows, keyFn, mkdFn = () => 0) {
  const out = {};
  for (const r of rows) {
    const k = keyFn(r);
    out[k] ??= { orders: 0, mkd: 0 };
    out[k].orders++;
    out[k].mkd += Number(mkdFn(r)) || 0;
  }
  return out;
}
