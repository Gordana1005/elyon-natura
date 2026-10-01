#!/usr/bin/env node
/**
 * Elyon Sigma connector — READS Sigma-SB (SQL Server, database SSBNatura) in the office and sends the stock
 * documents to the Macedonian CRM (POST /api/stock/sigma/ingest, HMAC). It never writes to Sigma.
 *
 *   node connector.mjs --mode delta      documents changed since the last run (+ the open drafts)   every 15 min 06–22
 *   node connector.mjs --mode snapshot   every posted document of the last N days (vanished = deleted in Sigma)
 *   node connector.mjs --mode items      the article master (АРТИКЛ / ТС / ЛОЈАЛИТИ)
 *   node connector.mjs --mode balances   StockObject of Ф00001-04 / 08 / 11 and Ф00002-00 (with CalcBuyPrice)
 *   node connector.mjs --mode nightly    snapshot + items + balances                                 03:30
 *   options: --config config.json  --dry (build only, nothing sent)  --out batch.json (write what would be sent)
 *            --print-grants (the SELECT-only SQL for the Sigma vendor)  --since 'YYYY-MM-DD HH:MM:SS' (delta)
 *
 * What leaves the office: only the keys of sigma-fields.json (documents, lines, items, balances; company names of
 * clients — never a person, an address, a phone or a note). The SQL login sees only those columns.
 * The batch shape is built by lib/batch.mjs — the same code the CRM's CSV import uses.
 * Exit code: 0 = sent (or dry), 1 = failed (the Task Scheduler history shows it; the next run catches up).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIELDS, chunkBatch, docTypeMap, draftDoc, postBatch, postedDoc, skopjeIso, toBalance, toItem, whitelist, workTypeOf,
} from './lib/batch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MODES = ['delta', 'snapshot', 'items', 'balances', 'nightly'];
const OWN = ['Ф00001', 'Ф00002', 'Ф00003'];

// ── arguments, config, log ──────────────────────────────────────────────────────────────────────────────────
function args(argv) {
  const out = { mode: null, config: join(HERE, 'config.json'), dry: false, out: null, printGrants: false, since: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mode') out.mode = argv[++i];
    else if (a === '--config') out.config = argv[++i];
    else if (a === '--dry') out.dry = true;
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--print-grants') out.printGrants = true;
    else if (a === '--since') out.since = argv[++i];
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}
const A = args(process.argv.slice(2));

function loadConfig(path) {
  if (!existsSync(path)) throw new Error(`no config at ${path} — copy config.example.json to config.json`);
  const c = JSON.parse(readFileSync(path, 'utf8'));
  const base = dirname(resolve(path));
  const abs = (p) => (isAbsolute(p) ? p : join(base, p));
  return {
    sql: c.sql,
    endpoint: c.endpoint,
    secret: process.env[c.secretEnv ?? 'SIGMA_CONNECTOR_SECRET'] ?? null,
    sqlPassword: process.env[c.sql?.passwordEnv ?? 'SIGMA_SQL_PASSWORD'] ?? null,
    stateFile: abs(c.stateFile ?? 'state.json'),
    logDir: abs(c.logDir ?? 'logs'),
    opening: c.opening ?? '2026-09-22',
    snapshotDays: Number(c.snapshotDays ?? 120),
    overlapMinutes: Number(c.overlapMinutes ?? 30),
  };
}

let LOGFILE = null;
function log(msg) {
  const line = `${new Date().toISOString()} ${msg}`;
  console.log(line);
  if (LOGFILE) { try { appendFileSync(LOGFILE, line + '\n'); } catch { /* the console still has it */ } }
}

// ── the SELECT-only grants (column level) for the Sigma vendor ──────────────────────────────────────────────
function grantsSql() {
  const out = [
    '-- Elyon Sigma connector: a SELECT-only login on SSBNatura, limited to the columns below (sigma-fields.json).',
    "USE [master];",
    "CREATE LOGIN [elyon_reader] WITH PASSWORD = N'<силна лозинка, 20+ знаци>', CHECK_POLICY = ON, DEFAULT_DATABASE = [SSBNatura];",
    'USE [SSBNatura];',
    'CREATE USER [elyon_reader] FOR LOGIN [elyon_reader];',
  ];
  for (const [table, cols] of Object.entries(FIELDS.sigma_tables)) {
    out.push(`GRANT SELECT ON [dbo].[${table}] (${cols.map((c) => `[${c}]`).join(', ')}) TO [elyon_reader];`);
  }
  out.push('-- nothing else: no INSERT / UPDATE / DELETE / EXECUTE, no other table, no other column.');
  return out.join('\n');
}

if (A.printGrants) {
  console.log(grantsSql());
  process.exit(0);
}
if (!MODES.includes(A.mode)) {
  console.error(`--mode must be one of ${MODES.join(', ')}`);
  process.exit(1);
}

// ── SQL ─────────────────────────────────────────────────────────────────────────────────────────────────────
let sql;
let pool;
async function connect(cfg) {
  ({ default: sql } = await import('mssql'));
  pool = await new sql.ConnectionPool({
    server: cfg.sql.server, port: Number(cfg.sql.port ?? 1433), database: cfg.sql.database ?? 'SSBNatura',
    user: cfg.sql.user ?? 'elyon_reader', password: cfg.sqlPassword ?? cfg.sql.password,
    options: { encrypt: cfg.sql.encrypt ?? true, trustServerCertificate: cfg.sql.trustServerCertificate ?? true,
      useUTC: true, readOnlyIntent: true, appName: 'elyon-sigma-connector' },
    requestTimeout: 120_000, connectionTimeout: 30_000, pool: { max: 2, min: 0 },
  }).connect();
}

/** Run a SELECT with named parameters ({name: [type, value]}). Only SELECT ever runs. */
async function q(text, params = {}) {
  if (!/^\s*(SELECT|WITH)\b/i.test(text)) throw new Error('the connector only reads');
  const req = pool.request();
  for (const [k, [type, v]] of Object.entries(params)) req.input(k, type, v);
  return (await req.query(text)).recordset;
}

const cols = (table, alias) => FIELDS.sigma_tables[table].map((c) => `${alias}.[${c}]`).join(', ');
const OBJ_DOCS = FIELDS.objects.docs.map((k) => k.split('-'));
const OBJ_BAL = FIELDS.objects.balances.map((k) => k.split('-'));
const touches = (alias, pairs) => pairs.map(([c, o]) =>
  `(RTRIM(${alias}.ClientFrom) = N'${c}' AND RTRIM(${alias}.ObjectFrom) = N'${o}') OR (RTRIM(${alias}.ClientTo) = N'${c}' AND RTRIM(${alias}.ObjectTo) = N'${o}')`).join(' OR ');
const inList = (vals) => vals.map((v) => `N'${v.replace(/'/g, "''")}'`).join(', ');
const trim = (v) => (v === null || v === undefined ? '' : String(v).trim());
const keyOf = (r) => `${trim(r.WYear)}|${trim(r.DocType)}|${trim(r.DocNo)}`;
const wall = (d) => {           // a DATETIME read with useUTC → 'YYYY-MM-DD HH:MM:SS' Sigma wall time
  if (!d) return null;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
};

/** Rows of `table` for the given document keys, in groups of 100 keys (parameterised). */
async function byKeys(table, alias, keys, extra = '') {
  const out = [];
  for (let i = 0; i < keys.length; i += 100) {
    const part = keys.slice(i, i + 100);
    const params = {};
    const ors = part.map((k, j) => {
      const [y, t, n] = k.split('|');
      params[`y${j}`] = [sql.NVarChar, y]; params[`t${j}`] = [sql.NVarChar, t]; params[`n${j}`] = [sql.NVarChar, n];
      return `(RTRIM(${alias}.WYear) = @y${j} AND RTRIM(${alias}.DocType) = @t${j} AND RTRIM(${alias}.DocNo) = @n${j})`;
    });
    out.push(...await q(`SELECT ${cols(table, alias)} FROM dbo.[${table}] ${alias} WHERE (${ors.join(' OR ')}) ${extra}`, params));
  }
  return out;
}

async function masterData() {
  const docTypes = docTypeMap(await q(`SELECT ${cols('DocType', 'd')} FROM dbo.DocType d`));
  const clients = {};
  for (const r of await q(`SELECT ${cols('Client', 'c')} FROM dbo.Client c`)) clients[trim(r.ClientID)] = trim(r.Name);
  return { docTypes, clients };
}

/** Posted documents (InventoryHead keys) → SigmaDoc[] with their lines and work documents. */
async function postedDocs(keys, md) {
  if (!keys.length) return [];
  const heads = await byKeys('InventoryHead', 'h', keys);
  const lines = await byKeys('InventoryLine', 'l', keys);
  const H = new Map(heads.map((h) => [keyOf(h), h]));
  const L = new Map();
  for (const l of lines) { const k = keyOf(l); if (!L.has(k)) L.set(k, []); L.get(k).push(l); }
  const workKeys = new Set();
  for (const k of keys) {
    const h = H.get(k);
    if (h && trim(h.SourceDocType)) workKeys.add(`${trim(h.SourceYear)}|${trim(h.SourceDocType)}|${trim(h.SourceDocNo)}`);
    const [y, t, n] = k.split('|');
    workKeys.add(`${y}|${workTypeOf(t)}|${n}`);
  }
  const W = new Map((await byKeys('WorkDocInHead', 'w', [...workKeys])).map((w) => [keyOf(w), w]));
  const docs = [];
  for (const k of keys) {
    const [y, t, n] = k.split('|');
    const head = H.get(k) ?? null;
    const ls = L.get(k) ?? [];
    if (!head && !ls.length) continue;                     // deleted between the two reads: the snapshot decides
    const work = (head && trim(head.SourceDocType) ? W.get(`${trim(head.SourceYear)}|${trim(head.SourceDocType)}|${trim(head.SourceDocNo)}`) : null)
      ?? W.get(`${y}|${workTypeOf(t)}|${n}`) ?? null;
    docs.push(whitelist(postedDoc({ wyear: y, docType: t, docNo: n, head, lines: ls, work, ...md }), FIELDS.doc_fields));
  }
  return docs;
}

/** Open drafts dated ≥ the opening that touch 04 / 08 / 11 and have no posted twin. */
async function openDrafts(cfg, md) {
  const heads = await q(
    `SELECT ${cols('WorkDocInHead', 'w')} FROM dbo.WorkDocInHead w
      WHERE RTRIM(CAST(w.Status AS nvarchar(10))) <> N'4' AND w.WDate >= CONVERT(datetime, @opening, 23)
        AND RTRIM(w.DocType) IN (${inList(FIELDS.draft_doc_types)}) AND (${touches('w', OBJ_DOCS)})`,
    { opening: [sql.NVarChar, cfg.opening] });
  if (!heads.length) return [];
  const twins = heads.map((w) => { const [y, t, n] = keyOf(w).split('|'); return `${y}|${t === 'МН2' ? 'ММ2' : `${t[0]}М${t.slice(2)}`}|${n}`; });
  const posted = new Set((await byKeys('InventoryHead', 'h', twins)).map(keyOf));
  const open = heads.filter((w, i) => !posted.has(twins[i]));
  const lines = await byKeys('WorkDocInLine', 'l', open.map(keyOf));
  const L = new Map();
  for (const l of lines) { const k = keyOf(l); if (!L.has(k)) L.set(k, []); L.get(k).push(l); }
  return open.map((h) => whitelist(draftDoc({ head: h, lines: L.get(keyOf(h)) ?? [], ...md }), FIELDS.doc_fields));
}

const POSTED_FILTER = (alias) => `RTRIM(${alias}.DocType) IN (${inList(FIELDS.posted_doc_types)}) AND (${touches(alias, OBJ_DOCS)})`;

async function deltaKeys(cfg, since) {
  const p = { since: [sql.NVarChar, since], opening: [sql.NVarChar, cfg.opening] };
  const a = await q(`SELECT h.WYear, h.DocType, h.DocNo FROM dbo.InventoryHead h
                      WHERE h.WDate >= CONVERT(datetime, @opening, 23) AND h.SysDateTime >= CONVERT(datetime, @since, 120)
                        AND ${POSTED_FILTER('h')}`, p);
  // a work document edited (re-dated, re-posted) since the watermark → its posted twin
  const b = await q(`SELECT h.WYear, h.DocType, h.DocNo FROM dbo.InventoryHead h
                       JOIN dbo.WorkDocInHead w ON RTRIM(w.WYear) = RTRIM(h.SourceYear) AND RTRIM(w.DocType) = RTRIM(h.SourceDocType)
                                               AND RTRIM(w.DocNo) = RTRIM(h.SourceDocNo)
                      WHERE w.LastChangeDateTime >= CONVERT(datetime, @since, 120) AND ${POSTED_FILTER('h')}`, p);
  const maxRow = await q(`SELECT MAX(x.t) AS t FROM (
                            SELECT MAX(h.SysDateTime) AS t FROM dbo.InventoryHead h
                            UNION ALL SELECT MAX(w.LastChangeDateTime) FROM dbo.WorkDocInHead w) x`);
  const keys = [...new Set([...a, ...b].map(keyOf))];
  return { keys, watermark: wall(maxRow[0]?.t) };
}

async function snapshotKeys(from, to) {
  const rows = await q(`SELECT h.WYear, h.DocType, h.DocNo FROM dbo.InventoryHead h
                         WHERE h.WDate >= CONVERT(datetime, @from, 23) AND h.WDate < DATEADD(day, 1, CONVERT(datetime, @to, 23))
                           AND ${POSTED_FILTER('h')}`,
  { from: [sql.NVarChar, from], to: [sql.NVarChar, to] });
  return [...new Set(rows.map(keyOf))];
}

async function itemsAndActivity() {
  const items = await q(`SELECT ${cols('Item', 'i')} FROM dbo.Item i WHERE RTRIM(i.AccountPG) IN (${inList(FIELDS.article_classes)})`);
  const sold = new Set((await q(`SELECT DISTINCT RTRIM(l.CodeID) AS c FROM dbo.InventoryLine l
                                   WHERE RTRIM(l.DocType) IN (N'ПМ1', N'ПМ2', N'ПМ15', N'ПМ100') AND l.WDate >= DATEADD(day, -365, GETDATE())
                                     AND RTRIM(l.ClientTo) NOT IN (${inList(OWN)})`)).map((r) => r.c));
  const stocked = new Set((await q(`SELECT RTRIM(s.ItemID) AS c FROM dbo.StockObject s
                                      WHERE (RTRIM(s.Client) = N'Ф00001' AND RTRIM(s.Object) IN (N'04', N'08')) OR (RTRIM(s.Client) = N'Ф00002' AND RTRIM(s.Object) = N'00')
                                      GROUP BY RTRIM(s.ItemID) HAVING SUM(s.InInventoryQuantity - s.OutInventoryQuantity) > 0`)).map((r) => r.c));
  return items.map((r) => toItem(r, sold.has(trim(r.ItemID)) || stocked.has(trim(r.ItemID)))).filter(Boolean)
    .map((it) => whitelist(it, FIELDS.item_fields));
}

async function balances() {
  const where = OBJ_BAL.map(([c, o]) => `(RTRIM(s.Client) = N'${c}' AND RTRIM(s.Object) = N'${o}')`).join(' OR ');
  const rows = await q(`SELECT ${cols('StockObject', 's')} FROM dbo.StockObject s WHERE ${where}`);
  return rows.map(toBalance).filter(Boolean).map((b) => whitelist(b, FIELDS.balance_fields))
    .sort((a, b) => (`${a.company}|${a.object}|${a.item_code}|${a.wyear}` < `${b.company}|${b.object}|${b.item_code}|${b.wyear}` ? -1 : 1));
}

// ── state (the delta watermark) ─────────────────────────────────────────────────────────────────────────────
function readState(cfg) {
  try { return JSON.parse(readFileSync(cfg.stateFile, 'utf8')); } catch { return {}; }
}
function writeState(cfg, state) {
  const tmp = `${cfg.stateFile}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, cfg.stateFile);
}
const minusMinutes = (wallTime, m) => {
  const d = new Date(`${wallTime.replace(' ', 'T')}Z`);
  return wall(new Date(d.getTime() - m * 60e3));
};
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date());
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const nowIso = () => {
  const p = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date());
  return p.replace(' ', 'T');
};

// ── one run ─────────────────────────────────────────────────────────────────────────────────────────────────
async function build(cfg, mode, state) {
  const md = await masterData();
  const exported = nowIso();
  const stamp = exported.replace(/[-:T]/g, '').slice(0, 14);
  const batch = { batch_id: null, source: 'connector', mode, exported_at: null };
  let watermark = null;
  if (mode === 'delta') {
    const since = A.since ?? (state.watermark ? minusMinutes(state.watermark, cfg.overlapMinutes) : `${cfg.opening} 00:00:00`);
    const d = await deltaKeys(cfg, since);
    batch.docs = await postedDocs(d.keys, md);
    batch.drafts = await openDrafts(cfg, md);
    batch.window = { from: cfg.opening, to: today() };
    watermark = d.watermark;
    log(`delta since ${since}: ${batch.docs.length} documents, ${batch.drafts.length} open drafts`);
  } else if (mode === 'snapshot') {
    const to = today();
    const from = [cfg.opening, addDays(to, -cfg.snapshotDays)].sort().at(-1);
    batch.window = { from, to };
    batch.docs = await postedDocs(await snapshotKeys(from, to), md);
    batch.drafts = await openDrafts(cfg, md);
    log(`snapshot ${from}…${to}: ${batch.docs.length} documents, ${batch.drafts.length} open drafts`);
  } else if (mode === 'items') {
    batch.items = await itemsAndActivity();
    log(`items: ${batch.items.length}`);
  } else if (mode === 'balances') {
    batch.balances = await balances();
    batch.balances_taken_at = exported;
    log(`balances: ${batch.balances.length} rows`);
  }
  const [clock] = await q('SELECT GETDATE() AS t');                // Sigma's own clock, Skopje wall time
  batch.exported_at = skopjeIso(clock?.t) ?? exported;
  if (batch.balances) batch.balances_taken_at = batch.exported_at;
  const digest = createHash('sha256').update(JSON.stringify(batch)).digest('hex').slice(0, 8);
  batch.batch_id = `conn-${mode}-${stamp}-${digest}`;
  return { batch, watermark };
}

async function send(cfg, batch) {
  const parts = chunkBatch(batch);
  log(`${batch.batch_id}: ${parts.length} request(s)`);
  for (const p of parts) {
    const { status, body } = await postBatch(cfg.endpoint, cfg.secret, p, { log });
    const st = body?.status ?? body?.result?.status;
    if (status === 200 && st === 'disabled') {
      throw new Error('the CRM answered "disabled": app_settings.stock_v2.sigma.ingest is OFF — an owner switches it on; nothing was stored, the next run sends it again');
    }
    if (status !== 200 || !['ok', 'duplicate'].includes(st)) {
      throw new Error(`${p.batch_id}: HTTP ${status} ${typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300)}`);
    }
    const docs = body?.docs ?? body?.result?.docs;
    log(`${p.batch_id}: ${st}${docs ? ` · docs ${JSON.stringify(docs)}` : ''}`);
  }
}

async function main() {
  const cfg = loadConfig(A.config);
  mkdirSync(cfg.logDir, { recursive: true });
  LOGFILE = join(cfg.logDir, `connector-${today()}.log`);
  if (!A.dry && (!cfg.endpoint || !cfg.secret)) throw new Error('endpoint and the secret (env SIGMA_CONNECTOR_SECRET) are required unless --dry');
  if (/sxymaloycddnoxudxaqp/.test(cfg.endpoint ?? '')) throw new Error('the endpoint points at the BULGARIAN CRM — refusing');
  await connect(cfg);
  const state = readState(cfg);
  const modes = A.mode === 'nightly' ? ['snapshot', 'items', 'balances'] : [A.mode];
  for (const mode of modes) {
    const { batch, watermark } = await build(cfg, mode, state);
    if (A.out) writeFileSync(modes.length > 1 ? A.out.replace(/(\.json)?$/, `-${mode}.json`) : A.out, JSON.stringify(batch, null, 1));
    if (A.dry) { log(`dry run — ${batch.batch_id} not sent`); continue; }
    await send(cfg, batch);
    if (mode === 'delta' && watermark && !A.since) state.watermark = watermark;
    state[`last_${mode}`] = new Date().toISOString();
    writeState(cfg, state);
  }
  await pool.close();
}

main().then(() => process.exit(0)).catch((e) => {
  log(`FAILED: ${e?.stack ?? e}`);
  process.exit(1);
});
