#!/usr/bin/env node
/**
 * The naturatherapy.mk → Elyon CRM bridge: the ONE approved change on the shop
 * database, plus the CRM-side wiring that needs its secrets.
 *
 * 🛑 The shop (Supabase kctgthpoeysmhmkrnkil) is a LIVE multi-tenant platform
 *    (BG, MK, AL, GR share one production DB). Owner rule 2026-09-27: nothing
 *    on it changes except schema crm_export (four read-only, late-bound
 *    PL/pgSQL functions over tenant 2 — no views, so NO dependency on any shop
 *    column: a shop schema change can only make our call fail, never block the
 *    shop's deploy) and the login role elyon_crm_reader (EXECUTE on those
 *    functions only, no table privilege anywhere). This script enforces that —
 *    statically on the SQL file and again at runtime by diffing the catalog
 *    inside the transaction, rolling back on ANY other change.
 *
 * Modes (default = dry run: static checks only, no connection):
 *
 *   node scripts/apply-shop-crm-export.mjs
 *   node scripts/apply-shop-crm-export.mjs --apply [--rotate-password]
 *       Applies supabase/shop-side/crm_export_tenant2.sql to the SHOP db as
 *       postgres (DIRECT_URL from the shop's .env), sets the reader password
 *       as a SCRAM-SHA-256 verifier (the plaintext never reaches the server),
 *       commits only if nothing outside crm_export + the role changed, then
 *       logs in AS the reader over the pooler and proves the isolation.
 *       Writes WEB_SHOP_DB_URL + WEB_SYNC_SECRET into docs/VAULT.md §8 (and
 *       nowhere else). Re-running keeps the existing password unless
 *       --rotate-password.
 *   node scripts/apply-shop-crm-export.mjs --verify
 *       Only the reader login proof (reads VAULT §8).
 *   node scripts/apply-shop-crm-export.mjs --set-function-secrets [--ca <pem>]
 *       Runs the MK tripwire, then sets WEB_SHOP_DB_URL + WEB_SYNC_SECRET (and
 *       WEB_SHOP_DB_CA if --ca) as function secrets on bmfxhgznttcnnlqloqzp via
 *       the Management API, and creates/updates the Vault row web_sync_secret.
 *   node scripts/apply-shop-crm-export.mjs --backfill | --sync
 *       Calls the deployed web-sync function (secret from VAULT §8): --backfill
 *       loops {backfill:true} until done; --sync runs one incremental pass.
 *
 * Options: --shop-env <file>   (default D:\naturatherapy\storefront\.env)
 *          --ca <pem file>     verify the shop's TLS certificate against it
 *
 * Needs the `pg` package (not a dependency of this repo). Either
 *   npm i --no-save pg@8
 * or install it anywhere and point PG_MODULE_DIR at that folder (the one that
 * contains node_modules):  npm i --prefix <dir> pg@8 && set PG_MODULE_DIR=<dir>
 *
 * Secrets are NEVER printed: not the shop's postgres password, not the
 * reader's, not the sync secret. Connection targets print with the password
 * masked.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const SHOP_REF = 'kctgthpoeysmhmkrnkil';
const SHOP_STAGING_REF = 'lwekxbsxabqzygfuhpdl';
const CRM_REF = 'bmfxhgznttcnnlqloqzp';           // Macedonia — secrets go here
const BG_REF = 'sxymaloycddnoxudxaqp';            // live Bulgaria — never
const READER = 'elyon_crm_reader';
const TENANT_SLUG = 'naturatherapy-mk';
const SQL_FILE = join(root, 'supabase', 'shop-side', 'crm_export_tenant2.sql');
const VAULT_FILE = join(root, 'docs', 'VAULT.md');
const VAULT_BEGIN = '<!-- §8:web-shop:begin (written by scripts/apply-shop-crm-export.mjs — do not hand-edit inside) -->';
const VAULT_END = '<!-- §8:web-shop:end -->';
const FUNCTION_URL = `https://${CRM_REF}.supabase.co/functions/v1/web-sync`;

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

const MODE = flag('--apply') ? 'apply'
  : flag('--verify') ? 'verify'
  : flag('--set-function-secrets') ? 'secrets'
  : flag('--backfill') ? 'backfill'
  : flag('--sync') ? 'sync'
  : 'dry';
const SHOP_ENV = resolve(opt('--shop-env') || process.env.SHOP_ENV_FILE || 'D:\\naturatherapy\\storefront\\.env');
const CA_FILE = opt('--ca');

const red = (s) => `\x1b[31m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const fail = (m) => { console.error(red(`✗ ${m}`)); process.exit(1); };
const ok = (m) => console.log(`${green('✓')} ${m}`);
const info = (m) => console.log(`· ${m}`);

// ─────────────────────────────────────────────────────────────── helpers ──
function readEnvFile(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Parses and validates a postgres URL; returns parts. Never includes the
 * password in an error or in `display`. */
function parsePgUrl(raw, label) {
  if (!raw) fail(`${label}: not set`);
  let u;
  try { u = new URL(raw); } catch { fail(`${label}: not a valid URL`); }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') fail(`${label}: not a postgres:// URL`);
  const user = decodeURIComponent(u.username);
  const host = u.hostname.toLowerCase();
  const port = Number(u.port || 5432);
  const database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres';
  return {
    user, host, port, database, password: decodeURIComponent(u.password),
    display: `${user}@${host}:${port}/${database} (password hidden)`,
  };
}

/** The shop's privileged URL: must be the PRODUCTION shop project and nothing else. */
function assertShopAdminTarget(p, raw) {
  for (const [ref, what] of [[CRM_REF, 'the Macedonian CRM'], [BG_REF, 'LIVE BULGARIA'], [SHOP_STAGING_REF, 'the shop STAGING project']]) {
    if (raw.includes(ref)) fail(`the shop URL points at ${what} (${ref}) — refusing`);
  }
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(p.host);
  const direct = p.host === `db.${SHOP_REF}.supabase.co`;
  if (pooler) {
    if (p.user !== `postgres.${SHOP_REF}`) fail(`pooler user must be postgres.${SHOP_REF}, got "${p.user}" — refusing`);
    if (p.port !== 5432) fail(`use the SESSION pooler (port 5432), not ${p.port} — DDL needs a session`);
  } else if (direct) {
    if (p.user !== 'postgres') fail(`direct user must be postgres, got "${p.user}" — refusing`);
  } else {
    fail(`host ${p.host} is not the shop project ${SHOP_REF} — refusing`);
  }
  if (!p.password) fail('the shop URL has no password');
}

function assertReaderUrl(p, raw) {
  for (const ref of [CRM_REF, BG_REF, SHOP_STAGING_REF]) if (raw.includes(ref)) fail('WEB_SHOP_DB_URL points at the wrong project — refusing');
  const pooler = /^aws-[0-9]+-[a-z0-9-]+\.pooler\.supabase\.com$/.test(p.host) && p.user === `${READER}.${SHOP_REF}`;
  const direct = p.host === `db.${SHOP_REF}.supabase.co` && p.user === READER;
  if (!pooler && !direct) fail(`WEB_SHOP_DB_URL must be ${READER} on ${SHOP_REF} (got ${p.display})`);
}

async function loadPg() {
  try { return (await import('pg')).default; } catch { /* try PG_MODULE_DIR */ }
  if (process.env.PG_MODULE_DIR) {
    try { return createRequire(join(resolve(process.env.PG_MODULE_DIR), 'noop.js'))('pg'); } catch { /* fall through */ }
  }
  fail('the `pg` package is not installed. Run `npm i --no-save pg@8` in this repo, or install it elsewhere and set PG_MODULE_DIR (see the header).');
}

function sslOptions() {
  if (CA_FILE) return { rejectUnauthorized: true, ca: readFileSync(CA_FILE, 'utf8') };
  // Encrypted, but the Supabase CA is not in Node's store — same trust level as
  // the shop's own Prisma tooling. Pass --ca to verify the certificate.
  return { rejectUnauthorized: false };
}

/** Postgres SCRAM-SHA-256 verifier (RFC 5802/7677; checked against the RFC
 * 7677 vector). The password is ASCII (base64url), so SASLprep is identity. */
function scramVerifier(password, iterations = 4096) {
  const salt = crypto.randomBytes(16);
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest();
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey.toString('base64')}:${serverKey.toString('base64')}`;
}

// ─────────────────────────────────────────── VAULT §8 (gitignored only) ──
function vaultIsIgnored() {
  const r = spawnSync('git', ['-C', root, 'check-ignore', '-q', 'docs/VAULT.md']);
  return r.status === 0;
}

function readVault8() {
  if (!existsSync(VAULT_FILE)) return {};
  const text = readFileSync(VAULT_FILE, 'utf8');
  const a = text.indexOf(VAULT_BEGIN), b = text.indexOf(VAULT_END);
  if (a < 0 || b < a) return {};
  const block = text.slice(a, b);
  return {
    url: block.match(/WEB_SHOP_DB_URL[\s\S]*?\n\s*`(postgres(?:ql)?:\/\/[^`\s]+)`/)?.[1],
    syncSecret: block.match(/WEB_SYNC_SECRET[\s\S]*?\n\s*`([0-9a-f]{64})`/)?.[1],
  };
}

function writeVault8({ url, syncSecret, rotated, readerDisplay }) {
  if (!vaultIsIgnored()) fail('docs/VAULT.md is NOT gitignored — refusing to write secrets into it');
  const text = existsSync(VAULT_FILE) ? readFileSync(VAULT_FILE, 'utf8') : '# VAULT\n';
  const block = [
    VAULT_BEGIN,
    '## §8 naturatherapy.mk web shop — read-only CRM export (shop DB kctgthpoeysmhmkrnkil)',
    '- Owner approval 2026-09-27 (the ONLY change allowed on the live shop): schema `crm_export`',
    '  (4 late-bound read-only functions over tenant slug `naturatherapy-mk`: mk_orders, mk_orders_by_id,',
    '  mk_order_items, mk_orders_summary — NO dependency on shop columns) + login role `elyon_crm_reader`',
    '  (USAGE on crm_export, EXECUTE on those 4 only, no table privilege, read-only, 30 s timeout,',
    '  3 connections). DDL: `supabase/shop-side/crm_export_tenant2.sql` (rollback block in its header).',
    `- Last applied: ${new Date().toISOString()} by scripts/apply-shop-crm-export.mjs` +
      ` (password ${rotated ? 'generated/rotated' : 'kept'}); reader = ${readerDisplay}`,
    '- `WEB_SHOP_DB_URL` (function secret on bmfxhgznttcnnlqloqzp for web-sync; the reader via the shop session pooler):',
    `  \`${url}\``,
    '- `WEB_SYNC_SECRET` (function secret + Vault row `web_sync_secret`; pg_cron sends it as `x-web-sync-secret`):',
    `  \`${syncSecret}\``,
    '- Set both on the function: `node scripts/apply-shop-crm-export.mjs --set-function-secrets`',
    VAULT_END,
  ].join('\n');
  const a = text.indexOf(VAULT_BEGIN), b = text.indexOf(VAULT_END);
  const next = a >= 0 && b > a
    ? text.slice(0, a) + block + text.slice(b + VAULT_END.length)
    : text.replace(/\s*$/, '\n\n') + block + '\n';
  writeFileSync(VAULT_FILE, next, 'utf8');
}

// ─────────────────────────────────── static guard on the shop SQL file ──
/** Splits SQL into top-level statements (quote-, comment- and $tag$-aware);
 * comments outside dollar-quoted bodies are dropped. */
function splitSql(sql) {
  const out = [];
  let cur = '';
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i], nx = sql[i + 1];
    if (ch === '-' && nx === '-') { const j = sql.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (ch === '/' && nx === '*') {
      const j = sql.indexOf('*/', i + 2);
      if (j < 0) throw new Error('unterminated block comment');
      cur += ' '; i = j + 2; continue;
    }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) throw new Error('unterminated string literal');
        if (sql[j] === "'") { if (sql[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '"') {
      const j = sql.indexOf('"', i + 1);
      if (j < 0) throw new Error('unterminated quoted identifier');
      cur += sql.slice(i, j + 1); i = j + 1; continue;
    }
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const j = sql.indexOf(tag, i + tag.length);
        if (j < 0) throw new Error(`unterminated ${tag} block`);
        cur += sql.slice(i, j + tag.length); i = j + tag.length; continue;
      }
    }
    if (ch === ';') { if (cur.trim()) out.push(cur.trim()); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Removes comments and string literals from PL/pgSQL source; returns the
 * code skeleton and the literals (for the dynamic-SQL check). */
function stripPlpgsql(src) {
  let code = '';
  const literals = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i], nx = src[i + 1];
    if (ch === '-' && nx === '-') { const j = src.indexOf('\n', i); i = j < 0 ? n : j; continue; }
    if (ch === '/' && nx === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; code += ' '; continue; }
    if (ch === "'") {
      let j = i + 1;
      for (;;) {
        if (j >= n) break;
        if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } break; }
        j++;
      }
      literals.push(src.slice(i + 1, j).replace(/''/g, "'"));
      code += "''"; i = j + 1; continue;
    }
    code += ch; i++;
  }
  return { code, literals };
}

const norm = (s) => s.replace(/\s+/g, ' ').trim();

// The export is FOUR late-bound PL/pgSQL functions — never a view or table
// (a view pins the shop columns it selects; see the SQL file's header).
const EXPORT_FUNCTIONS = ['crm_export.mk_orders', 'crm_export.mk_orders_by_id', 'crm_export.mk_order_items', 'crm_export.mk_orders_summary'];
const FN_SIG = String.raw`crm_export\.[a-z_]+\([a-z\[\], ]*\)`;
const TOP_LEVEL_ALLOWED = [
  /^BEGIN$/i,
  /^COMMIT$/i,
  /^SET LOCAL (lock_timeout|statement_timeout) = '[0-9]+s'$/i,
  /^CREATE SCHEMA IF NOT EXISTS crm_export$/i,
  /^REVOKE ALL ON SCHEMA crm_export FROM PUBLIC$/i,
  new RegExp(String.raw`^COMMENT ON (SCHEMA crm_export|FUNCTION ${FN_SIG}|ROLE elyon_crm_reader) IS '(?:[^']|'')*'$`, 'i'),
  /^DROP VIEW IF EXISTS crm_export\.[a-z_]+$/i,                       // removes the earlier view draft
  new RegExp(String.raw`^DROP FUNCTION IF EXISTS ${FN_SIG}$`, 'i'),
  /^GRANT USAGE ON SCHEMA crm_export TO elyon_crm_reader$/i,
  new RegExp(String.raw`^GRANT EXECUTE ON FUNCTION ${FN_SIG}(, ${FN_SIG})* TO elyon_crm_reader$`, 'i'),
];
// Exactly how every export function must be declared.
const FN_OPTIONS = "LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET TimeZone = 'UTC'";
const SHOP_TABLES = /^public\."(Order|OrderItem|Tenant)"$/;
const DANGEROUS_WORDS = /\b(INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|TRUNCATE|MERGE\s+INTO|COPY\s|DROP\s|ALTER\s|GRANT\s|REVOKE\s|COMMENT\s+ON|SECURITY\s+LABEL|REASSIGN|VACUUM|CLUSTER|REINDEX|LOCK\s+TABLE|CALL\s|DBLINK|PG_TERMINATE_BACKEND|PG_CANCEL_BACKEND|SET_CONFIG|LO_IMPORT|LO_EXPORT|PG_READ_FILE|COPY_TO)/i;
const DYNAMIC_ALLOWED = new Set(['REVOKE ALL ON FUNCTION %s FROM PUBLIC', 'REVOKE ALL ON FUNCTION %s FROM %I']);
// A literal that STARTS a statement (verb + more text). A bare privilege name
// such as 'CREATE' passed to has_schema_privilege() is not dynamic SQL.
const DYNAMIC_VERB = /^\s*(REVOKE|GRANT|ALTER|DROP|CREATE|INSERT|UPDATE|DELETE|TRUNCATE|COPY|MERGE|COMMENT|SECURITY|REASSIGN|SET\s+ROLE|RESET)\s+\S/i;

function staticGuard(sql) {
  const stmts = splitSql(sql);
  // Executable text only — the header comment names these refs on purpose.
  const code = stmts.join(';\n');
  for (const ref of [CRM_REF, BG_REF, SHOP_STAGING_REF]) {
    if (code.includes(ref)) throw new Error(`an executable statement mentions project ${ref}`);
  }
  if (!/^BEGIN$/i.test(norm(stmts[0] || '')) || !/^COMMIT$/i.test(norm(stmts[stmts.length - 1] || ''))) {
    throw new Error('the file must be exactly one BEGIN … COMMIT transaction');
  }
  const problems = [];
  const functions = [];
  let doBlocks = 0;
  stmts.forEach((raw, idx) => {
    const s = norm(raw);
    const where = `statement ${idx + 1} (${s.slice(0, 60)}…)`;
    if (idx > 0 && idx < stmts.length - 1 && /^(BEGIN|COMMIT|ROLLBACK)$/i.test(s)) { problems.push(`${where}: nested transaction control`); return; }
    if (TOP_LEVEL_ALLOWED.some((re) => re.test(s))) return;

    if (/^ALTER ROLE elyon_crm_reader (WITH |SET )/i.test(s)) {
      if (/\b(PASSWORD|RENAME|VALID\s+UNTIL)\b/i.test(s)) problems.push(`${where}: role password/rename is set by this script, not the file`);
      for (const w of ['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'REPLICATION', 'BYPASSRLS', 'INHERIT']) {
        const re = new RegExp(`(^|\\s)${w}\\b`, 'i');
        if (re.test(s)) problems.push(`${where}: grants ${w}`);
      }
      if (/ SET /i.test(s) && !/ SET (default_transaction_read_only = on|statement_timeout = '[0-9]+s'|idle_in_transaction_session_timeout = '[0-9]+s')$/i.test(s)) {
        problems.push(`${where}: unexpected role setting`);
      }
      return;
    }
    const fnM = /^CREATE FUNCTION (crm_export\.[a-z_]+)\(([\s\S]*?)\)\s+RETURNS\s+([\s\S]*?)\s+AS\s+(\$[A-Za-z_]*\$)([\s\S]*)\4$/i.exec(raw.trim());
    if (fnM) {
      const [, fname, , returns, , body] = fnM;
      functions.push(fname);
      if (!EXPORT_FUNCTIONS.includes(fname)) problems.push(`${where}: unexpected function ${fname}`);
      // RETURNS TABLE (…) then the options — which must be exactly FN_OPTIONS.
      const opts = norm(returns.slice(returns.lastIndexOf(')') + 1));
      if (!/^TABLE\s*\(/i.test(returns.trim())) problems.push(`${where}: must RETURNS TABLE (…)`);
      if (opts !== FN_OPTIONS) problems.push(`${where}: options must be "${FN_OPTIONS}", got "${opts}"`);
      const { code, literals } = stripPlpgsql(body);
      const c = norm(code);
      const m = DANGEROUS_WORDS.exec(c);
      if (m) problems.push(`${where}: function body contains "${m[0]}"`);
      const stmtWord = /\b(EXECUTE|CREATE|PERFORM|SET|RESET|COPY|NOTIFY)\b/i.exec(c);
      if (stmtWord) problems.push(`${where}: function body uses ${stmtWord[1]} (read-only static SQL only)`);
      for (const fm of c.matchAll(/\b(FROM|JOIN)\s+(\S+)/gi)) {
        if (!SHOP_TABLES.test(fm[2])) problems.push(`${where}: reads "${fm[2]}" — only public."Order"/"OrderItem"/"Tenant", fully qualified`);
      }
      for (const lit of literals) {
        if (DYNAMIC_VERB.test(lit)) problems.push(`${where}: SQL-looking literal "${lit.slice(0, 50)}"`);
      }
      return;
    }
    const doM = /^DO (\$[A-Za-z_]*\$)([\s\S]*)\1$/.exec(raw.trim());
    if (doM) {
      doBlocks++;
      const { code, literals } = stripPlpgsql(doM[2]);
      const c = norm(code);
      const m = DANGEROUS_WORDS.exec(c);
      if (m) problems.push(`${where}: DO block contains "${m[0]}"`);
      for (const cm of c.matchAll(/\bCREATE\s+(\w+(?:\s+\w+)?)/gi)) {
        if (!/^ROLE elyon_crm_reader$/i.test(cm[1])) problems.push(`${where}: DO block creates "${cm[1]}"`);
      }
      for (const sm of c.matchAll(/\b(SET\s+(?:LOCAL\s+)?ROLE\s+\w+|RESET\s+\w+)/gi)) {
        if (!/^(SET LOCAL ROLE elyon_crm_reader|RESET ROLE)$/i.test(norm(sm[1]))) problems.push(`${where}: DO block runs "${sm[1]}"`);
      }
      for (const pm of c.matchAll(/\bPERFORM\s+(\S+)/gi)) {
        if (pm[1] !== '1') problems.push(`${where}: DO block PERFORMs "${pm[1]}"`);
      }
      for (const lit of literals) {
        if (DYNAMIC_VERB.test(lit) && !DYNAMIC_ALLOWED.has(lit.trim())) problems.push(`${where}: dynamic SQL "${lit.slice(0, 50)}"`);
      }
      return;
    }
    problems.push(`${where}: not an allowed statement`);
  });
  const missing = EXPORT_FUNCTIONS.filter((f) => !functions.includes(f));
  if (missing.length || functions.length !== EXPORT_FUNCTIONS.length) {
    problems.push(`expected exactly the functions ${EXPORT_FUNCTIONS.join(', ')}; found ${functions.join(', ') || 'none'}`);
  }
  if (problems.length) throw new Error(`static guard refused the SQL file:\n  - ${problems.join('\n  - ')}`);
  return { stmts, functions: functions.length, doBlocks };
}

// ──────────────────────────────── runtime guard: the catalog, before/after ──
const SNAPSHOT_SQL = `
WITH r AS (SELECT (SELECT oid FROM pg_roles WHERE rolname = '${READER}') AS reader,
                  (SELECT oid FROM pg_namespace WHERE nspname = 'crm_export') AS ns)
SELECT 'namespaces' AS k, md5(coalesce(string_agg(format('%s|%s|%s', n.nspname, n.nspowner, n.nspacl), E'\\n' ORDER BY n.nspname), '')) AS h
  FROM pg_namespace n WHERE n.nspname <> 'crm_export' AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast\\_temp\\_%'
UNION ALL
SELECT 'relations', md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s', n.nspname, c.relname, c.relkind, c.relowner, c.relacl, c.reloptions, c.relrowsecurity), E'\\n' ORDER BY n.nspname, c.relname), ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname <> 'crm_export' AND n.nspname NOT LIKE 'pg\\_temp\\_%' AND n.nspname NOT LIKE 'pg\\_toast%'
UNION ALL
SELECT 'columns', md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', a.attrelid, a.attname, a.atttypid, a.attnotnull, a.atthasdef, a.attacl), E'\\n' ORDER BY a.attrelid, a.attnum), ''))
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE a.attnum > 0 AND NOT a.attisdropped
   AND n.nspname NOT IN ('crm_export', 'pg_catalog', 'information_schema') AND n.nspname NOT LIKE 'pg\\_t%'
UNION ALL
SELECT 'functions', md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', p.pronamespace, p.proname, pg_get_function_identity_arguments(p.oid), md5(p.prosrc), p.proacl, p.prosecdef), E'\\n' ORDER BY p.oid), ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
 WHERE n.nspname NOT IN ('crm_export', 'pg_catalog', 'information_schema')
UNION ALL
SELECT 'triggers', md5(coalesce(string_agg(format('%s|%s|%s', t.tgrelid, t.tgname, t.tgenabled), E'\\n' ORDER BY t.oid), ''))
  FROM pg_trigger t WHERE NOT t.tgisinternal
UNION ALL
SELECT 'policies', md5(coalesce(string_agg(format('%s|%s|%s|%s', p.polrelid, p.polname, p.polcmd, p.polroles), E'\\n' ORDER BY p.oid), ''))
  FROM pg_policy p
UNION ALL
SELECT 'constraints', md5(coalesce(string_agg(format('%s|%s|%s', c.conrelid, c.conname, c.contype), E'\\n' ORDER BY c.oid), ''))
  FROM pg_constraint c, r WHERE c.connamespace IS DISTINCT FROM r.ns
UNION ALL
SELECT 'roles', md5(coalesce(string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', a.rolname, a.rolsuper, a.rolinherit, a.rolcreaterole, a.rolcreatedb, a.rolcanlogin, a.rolreplication, a.rolbypassrls, a.rolconnlimit), E'\\n' ORDER BY a.rolname), ''))
  FROM pg_roles a WHERE a.rolname <> '${READER}'
UNION ALL
SELECT 'memberships', md5(coalesce(string_agg(format('%s|%s|%s', m.roleid, m.member, m.admin_option), E'\\n' ORDER BY m.roleid, m.member), ''))
  FROM pg_auth_members m, r WHERE m.roleid IS DISTINCT FROM r.reader AND m.member IS DISTINCT FROM r.reader
UNION ALL
SELECT 'role_settings', md5(coalesce(string_agg(format('%s|%s|%s', s.setdatabase, s.setrole, s.setconfig), E'\\n' ORDER BY s.setdatabase, s.setrole), ''))
  FROM pg_db_role_setting s, r WHERE s.setrole IS DISTINCT FROM r.reader
UNION ALL
SELECT 'default_acl', md5(coalesce(string_agg(format('%s|%s|%s|%s', d.defaclrole, d.defaclnamespace, d.defaclobjtype, d.defaclacl), E'\\n' ORDER BY d.oid), ''))
  FROM pg_default_acl d
UNION ALL
SELECT 'databases', md5(coalesce(string_agg(format('%s|%s|%s', d.datname, d.datacl, d.datconnlimit), E'\\n' ORDER BY d.datname), ''))
  FROM pg_database d
UNION ALL
SELECT 'extensions', md5(coalesce(string_agg(format('%s|%s', e.extname, e.extversion), E'\\n' ORDER BY e.extname), ''))
  FROM pg_extension e
UNION ALL
SELECT 'event_triggers', md5(coalesce(string_agg(format('%s|%s|%s', e.evtname, e.evtevent, e.evtenabled), E'\\n' ORDER BY e.evtname), ''))
  FROM pg_event_trigger e`;

// Row writes per table as this backend sees them. NOT an absolute test: since
// Postgres 15 these counters also hold the backend's committed-but-unflushed
// counts from earlier transactions (a pooled server connection can carry
// another client's writes for a few seconds). So it is read right after BEGIN
// and again before COMMIT, and only the DIFFERENCE is this transaction's.
const XACT_WRITES_SQL = `SELECT relid::text AS relid, schemaname || '.' || relname AS name,
  (n_tup_ins + n_tup_upd + n_tup_del)::bigint AS n
  FROM pg_stat_xact_user_tables`;

async function snapshot(client) {
  const { rows } = await client.query(SNAPSHOT_SQL);
  return Object.fromEntries(rows.map((r) => [r.k, r.h]));
}

async function xactWrites(client) {
  const { rows } = await client.query(XACT_WRITES_SQL);
  return new Map(rows.map((r) => [r.relid, { name: r.name, n: Number(r.n) }]));
}

/** Tables this transaction wrote rows to (after − before). */
function writesBetween(before, after) {
  const hit = [];
  for (const [relid, a] of after) {
    const d = a.n - (before.get(relid)?.n ?? 0);
    if (d > 0) hit.push(`${a.name} (+${d})`);
  }
  return hit;
}

// ─────────────────────────────── reader proof (logs in AS the reader) ──
async function proveReader(pg, readerUrl) {
  const p = parsePgUrl(readerUrl, 'WEB_SHOP_DB_URL');
  assertReaderUrl(p, readerUrl);
  let client;
  for (let attempt = 1; ; attempt++) {
    client = new pg.Client({
      host: p.host, port: p.port, user: p.user, password: p.password, database: p.database,
      ssl: sslOptions(), application_name: 'elyon-crm-export-verify',
    });
    try { await client.connect(); break; } catch (e) {
      try { await client.end(); } catch { /* ignore */ }
      if (attempt >= 3) throw new Error(`could not log in as the reader (${p.display}): ${e.message}`);
      info(`reader login attempt ${attempt} failed (${e.code || e.message}); retrying in 5 s`);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  const results = [];
  const expectDenied = async (label, sql, codes = ['42501']) => {
    try {
      await client.query(sql);
      results.push([false, `${label}: SUCCEEDED — the reader must not be able to do this`]);
    } catch (e) {
      results.push([codes.includes(e.code), `${label}: refused (${e.code})`]);
    }
  };
  try {
    const who = (await client.query('SELECT current_user AS u, current_setting(\'default_transaction_read_only\') AS ro, current_setting(\'statement_timeout\') AS st')).rows[0];
    results.push([who.u === READER, `logged in as ${who.u}`]);
    results.push([who.ro === 'on', `default_transaction_read_only = ${who.ro}`]);
    results.push([who.st === '30s', `statement_timeout = ${who.st}`]);
    await expectDenied('SELECT public."Order"', 'SELECT 1 FROM public."Order" LIMIT 1');
    await expectDenied('SELECT public."OrderItem"', 'SELECT 1 FROM public."OrderItem" LIMIT 1');
    await expectDenied('SELECT public."Tenant"', 'SELECT 1 FROM public."Tenant" LIMIT 1');
    await expectDenied('SELECT public."Customer"', 'SELECT 1 FROM public."Customer" LIMIT 1');
    // A write attempt that can never persist: inside a transaction that is
    // always rolled back, even if (wrongly) the CREATE were allowed.
    try {
      await client.query('BEGIN READ WRITE');
      await expectDenied('CREATE TABLE in crm_export', 'CREATE TABLE crm_export.__elyon_probe (i int)', ['42501', '25006']);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
    }
    await expectDenied('CREATE FUNCTION in crm_export',
      'CREATE FUNCTION crm_export.__elyon_probe() RETURNS int LANGUAGE sql AS $p$ SELECT 1 $p$', ['42501', '25006']);

    // Sweep the whole export exactly as web-sync's backfill will (as the reader).
    const o = { n: 0, foreign: 0, legacy: 0, native: 0, other: 0, nonMkd: 0, first: null, last: null, lastUpd: null };
    const ids = [];
    for (let after = 0; ;) {
      const { rows } = await client.query(`SELECT shop_order_id, order_number, tenant_slug, currency,
          to_char(created_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') AS c,
          to_char(updated_at AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD HH24:MI') AS u
        FROM crm_export.mk_orders_by_id($1, 2000)`, [after]);
      for (const r of rows) {
        o.n++; ids.push(r.shop_order_id);
        if (r.tenant_slug !== TENANT_SLUG) o.foreign++;
        if (/^OC-[0-9]{1,12}$/.test(r.order_number)) o.legacy++;
        else if (/^NTMK[0-9]{1,12}$/.test(r.order_number)) o.native++;
        else o.other++;
        if (r.currency !== 'MKD') o.nonMkd++;
        if (!o.first || r.c < o.first) o.first = r.c;
        if (!o.last || r.c > o.last) o.last = r.c;
        if (!o.lastUpd || r.u > o.lastUpd) o.lastUpd = r.u;
      }
      if (rows.length < 2000) break;
      after = rows[rows.length - 1].shop_order_id;
    }
    let lines = 0, foreignLines = 0;
    for (let i = 0; i < ids.length; i += 2000) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_slug IS DISTINCT FROM '${TENANT_SLUG}')::int AS f
           FROM crm_export.mk_order_items($1::int[])`, [ids.slice(i, i + 2000)]);
      lines += rows[0].n; foreignLines += rows[0].f;
    }
    // Ids that are mostly NOT tenant 2 (the platform-wide sequence starts with
    // tenant 1's orders): whatever comes back must still be tenant 2's.
    const mine = new Set(ids);
    const probe = (await client.query(
      `SELECT shop_order_id, tenant_slug FROM crm_export.mk_order_items(ARRAY(SELECT generate_series(1, 2000)))`)).rows;
    const leaked = probe.filter((r) => r.tenant_slug !== TENANT_SLUG || !mine.has(r.shop_order_id)).length;
    const sum = (await client.query('SELECT orders::int AS n FROM crm_export.mk_orders_summary()')).rows[0];
    const inc = (await client.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE tenant_slug IS DISTINCT FROM '${TENANT_SLUG}')::int AS f
      FROM crm_export.mk_orders(NULL, 0, 2000)`)).rows[0];

    results.push([o.foreign === 0 && foreignLines === 0 && inc.f === 0, `foreign-tenant rows returned: orders ${o.foreign}, lines ${foreignLines}, incremental page ${inc.f}`]);
    results.push([leaked === 0, `mk_order_items(ids 1…2000): ${probe.length} lines back, ${leaked} not tenant 2's`]);
    results.push([o.n > 0 && sum.n === o.n, `export: ${o.n} orders (summary ${sum.n}; ${o.legacy} OC-… legacy, ${o.native} NTMK… native, ${o.other} other numbers, ${o.nonMkd} not MKD), ${o.first} → ${o.last}, last update ${o.lastUpd} Skopje`]);
    results.push([true, `export: ${lines} order lines`]);
    if (o.other > 0) info(`NOTE: ${o.other} tenant-2 orders have a number that is neither OC-… nor NTMK… — web-sync will not mirror them (warning, see its header)`);
  } finally {
    await client.end().catch(() => {});
  }
  let allOk = true;
  for (const [good, line] of results) { (good ? ok : (m) => console.error(red(`✗ ${m}`)))(line); allOk &&= good; }
  return allOk;
}

// ─────────────────────────────────────────────────────────────── modes ──
async function modeDryOrApply(apply) {
  console.log(`\nShop DDL — ${apply ? 'APPLY' : 'dry run (no connection)'}\n`);
  if (!existsSync(SHOP_ENV)) fail(`shop env file not found: ${SHOP_ENV}`);
  const shopEnv = readEnvFile(SHOP_ENV);
  const raw = shopEnv.DIRECT_URL;
  const admin = parsePgUrl(raw, `DIRECT_URL in ${SHOP_ENV}`);
  assertShopAdminTarget(admin, raw);
  ok(`target: ${admin.display} — shop project ${SHOP_REF}`);

  const sql = readFileSync(SQL_FILE, 'utf8');
  const { stmts, functions, doBlocks } = staticGuard(sql);
  ok(`static guard: ${stmts.length} statements, ${functions} late-bound functions, no views, ${doBlocks} DO blocks — only crm_export + ${READER}`);

  const vault = readVault8();
  info(`VAULT §8: ${vault.url ? 'reader URL present' : 'no reader URL yet'}, ${vault.syncSecret ? 'sync secret present' : 'no sync secret yet'}`);
  info(`reader password: ${!vault.url || flag('--rotate-password') ? 'will be GENERATED' : 'kept from VAULT §8'}`);
  if (!apply) {
    console.log('\nDry run only. Re-run with --apply to execute (the main session, after review).\n');
    return;
  }

  const pg = await loadPg();
  const client = new pg.Client({
    host: admin.host, port: admin.port, user: admin.user, password: admin.password, database: admin.database,
    ssl: sslOptions(), application_name: 'elyon-crm-export-apply',
  });
  client.on('notice', (n) => info(`notice: ${n.message}`));
  await client.connect();

  const rotate = !vault.url || flag('--rotate-password');
  const password = rotate ? crypto.randomBytes(32).toString('base64url') : parsePgUrl(vault.url, 'VAULT §8 WEB_SHOP_DB_URL').password;
  if (!password) fail('could not determine the reader password');

  let committed = false;
  try {
    // Server-side fingerprint before anything runs.
    const fp = (await client.query(`SELECT current_database() AS db,
        to_regclass('public."Order"') IS NOT NULL AS has_order,
        to_regclass('public.orders') IS NOT NULL AS has_crm_orders,
        (SELECT count(*) FROM public."Tenant" WHERE slug = '${TENANT_SLUG}')::int AS mk_tenant`)).rows[0];
    if (!fp.has_order || fp.has_crm_orders || fp.mk_tenant !== 1) fail('the connected database does not look like the shop (Order table / tenant naturatherapy-mk) — aborting');
    ok(`connected: database ${fp.db}, tenant ${TENANT_SLUG} present`);

    await client.query('BEGIN');
    const before = await snapshot(client);
    const writesBefore = await xactWrites(client);
    for (const s of stmts.slice(1, -1)) await client.query(s);    // BEGIN/COMMIT are ours
    await client.query(`ALTER ROLE ${READER} WITH PASSWORD '${scramVerifier(password)}'`);
    const after = await snapshot(client);
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    const wrote = writesBetween(writesBefore, await xactWrites(client));
    if (changed.length || wrote.length) {
      await client.query('ROLLBACK');
      fail(`ROLLED BACK — the file changed more than crm_export + ${READER}: ` +
        `${changed.length ? `catalog [${changed.join(', ')}]` : ''} ${wrote.length ? `row writes on ${wrote.join(', ')}` : ''}`);
    }
    ok('runtime guard: nothing outside crm_export and the reader role changed, no row was written');
    await client.query('COMMIT');
    committed = true;
    ok('committed: schema crm_export (4 read-only functions, no dependency on shop columns), role elyon_crm_reader (password set as SCRAM verifier)');
  } catch (e) {
    if (!committed) await client.query('ROLLBACK').catch(() => {});
    await client.end().catch(() => {});
    fail(`apply failed (rolled back): ${e.message}`);
  }
  await client.end().catch(() => {});

  // The reader URL goes through the same session pooler host the admin URL uses.
  const pooled = /\.pooler\.supabase\.com$/.test(admin.host);
  const readerUser = pooled ? `${READER}.${SHOP_REF}` : READER;
  const readerUrl = `postgresql://${readerUser}:${password}@${admin.host}:${admin.port}/${admin.database}?sslmode=require`;
  const syncSecret = vault.syncSecret || crypto.randomBytes(32).toString('hex');
  writeVault8({ url: readerUrl, syncSecret, rotated: rotate, readerDisplay: `${readerUser}@${admin.host}:${admin.port}` });
  ok('docs/VAULT.md §8 updated (WEB_SHOP_DB_URL, WEB_SYNC_SECRET) — values not shown');

  console.log('\nProving the isolation by logging in AS the reader…');
  const proven = await proveReader(pg, readerUrl);
  if (!proven) fail('reader proof FAILED — do not wire web-sync until this passes (re-check with --verify)');
  printNextSteps(rotate);
}

function printNextSteps(rotated) {
  console.log(`
${green('Shop side done.')} Next, in this order (main session):
  1. node scripts/assert-mk-target.mjs
     node scripts/apply-migration-mk.mjs 20260937000000_web_orders.sql
  2. node scripts/apply-shop-crm-export.mjs --set-function-secrets${rotated ? '        (the reader password is NEW — this step is required)' : ''}
  3. node scripts/assert-mk-target.mjs
     npx supabase functions deploy web-sync --project-ref ${CRM_REF}
  4. node scripts/apply-shop-crm-export.mjs --backfill      (loops until done; ~3 calls for ~24.5k orders)
  5. node scripts/apply-migration-mk.mjs 20260937000100_web_sync_cron.sql
`);
}

async function modeVerify() {
  const vault = readVault8();
  if (!vault.url) fail('VAULT §8 has no WEB_SHOP_DB_URL — run --apply first');
  const pg = await loadPg();
  const proven = await proveReader(pg, vault.url);
  if (!proven) fail('reader proof FAILED');
  ok('reader proof passed');
}

async function modeSecrets() {
  console.log('\nFunction secrets → bmfxhgznttcnnlqloqzp (Macedonia)\n');
  const trip = spawnSync(process.execPath, [join(root, 'scripts', 'assert-mk-target.mjs')], { cwd: root, stdio: 'inherit' });
  if (trip.status !== 0) fail('tripwire refused — not setting anything');

  const vault = readVault8();
  if (!vault.url || !vault.syncSecret) fail('VAULT §8 is incomplete — run --apply first');
  assertReaderUrl(parsePgUrl(vault.url, 'WEB_SHOP_DB_URL'), vault.url);
  if (!/^[0-9a-f]{64}$/.test(vault.syncSecret)) fail('WEB_SYNC_SECRET in VAULT §8 is not 64 hex characters');

  const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
  if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== CRM_REF) fail('config.toml does not point at Macedonia');
  const env = readEnvFile(join(root, '.env'));
  const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
  if (!token) fail('SUPABASE_ACCESS_TOKEN missing');

  const secrets = [
    { name: 'WEB_SHOP_DB_URL', value: vault.url },
    { name: 'WEB_SYNC_SECRET', value: vault.syncSecret },
  ];
  if (CA_FILE) secrets.push({ name: 'WEB_SHOP_DB_CA', value: readFileSync(CA_FILE, 'utf8') });
  const res = await fetch(`https://api.supabase.com/v1/projects/${CRM_REF}/secrets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(secrets),
  });
  if (!res.ok) fail(`setting function secrets failed: HTTP ${res.status}`);
  ok(`function secrets set on ${CRM_REF}: ${secrets.map((s) => s.name).join(', ')}`);

  const q = async (query) => {
    const r = await fetch(`https://api.supabase.com/v1/projects/${CRM_REF}/database/query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  };
  try {
    const existing = await q(`SELECT id FROM vault.secrets WHERE name = 'web_sync_secret'`);
    if (existing.length) await q(`SELECT vault.update_secret('${existing[0].id}', '${vault.syncSecret}')`);
    else await q(`SELECT vault.create_secret('${vault.syncSecret}', 'web_sync_secret', 'web-sync pg_cron → x-web-sync-secret')`);
    ok(`Vault row web_sync_secret ${existing.length ? 'updated' : 'created'} on ${CRM_REF}`);
  } catch (e) {
    fail(`Vault row failed: ${e.message}`);
  }
}

async function callFunction(body) {
  const vault = readVault8();
  if (!vault.syncSecret) fail('VAULT §8 has no WEB_SYNC_SECRET — run --apply first');
  const res = await fetch(FUNCTION_URL, {
    method: 'POST',
    headers: { 'x-web-sync-secret': vault.syncSecret, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  let json;
  try { json = await res.json(); } catch { json = { error: `HTTP ${res.status}, non-JSON body` }; }
  return { status: res.status, json };
}

async function modeBackfill() {
  const first = { backfill: true, ...(flag('--restart') ? { restart: true } : {}) };
  for (let i = 1; i <= 12; i++) {
    const { status, json } = await callFunction(i === 1 ? first : { backfill: true });
    const { rejected_sample: _s, ...summary } = json;
    console.log(`call ${i}: HTTP ${status}`, JSON.stringify(summary));
    if (status !== 200 || json.ok === false) fail('backfill stopped — see the response above and web_sync_runs');
    if (json.done) { ok('backfill complete'); return; }
  }
  fail('backfill not finished after 12 calls — run --backfill again to continue');
}

async function modeSync() {
  const { status, json } = await callFunction({});
  console.log(`HTTP ${status}`, JSON.stringify(json));
  if (status !== 200 || json.ok === false) process.exit(1);
}

const run = { dry: () => modeDryOrApply(false), apply: () => modeDryOrApply(true), verify: modeVerify,
  secrets: modeSecrets, backfill: modeBackfill, sync: modeSync }[MODE];
try {
  await run();
} catch (e) {
  fail(e.message);
}
