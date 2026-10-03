/**
 * rls-initplan — rewrite RLS policy expressions into the InitPlan form (01.10.2026).
 *
 * Why: a policy that calls `auth.uid()` or a role helper such as
 * `public.has_role(auth.uid(), 'admin'::public.app_role)` directly is evaluated PER ROW whenever
 * the query also carries a non-leakproof predicate (LIKE, most functions): Postgres must apply
 * the RLS quals before that predicate. On 01.10 an agent's phone search on `orders` ran
 * has_role() on ~358k rows and hit the statement timeout (20260944000450). Wrapping the call
 * in a scalar sub-select — `(SELECT auth.uid())`, `(SELECT public.has_role((SELECT auth.uid()),
 * 'admin'::public.app_role))` — makes the planner compute it ONCE per query (an InitPlan).
 * Every wrapped call is STABLE and gets no column of the row, so its value is the same for
 * every row of the statement: who may see or write what does not change.
 *
 * The text this module works on is pg_get_expr() output read with `search_path = ''` (every
 * object schema-qualified, every sub-select printed as `( SELECT … AS alias)`).
 *
 * PURE: no I/O here except `mkClient()` at the bottom (the Macedonian Management API, pinned).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** auth.* functions that only read the request's JWT — constant for a whole statement. */
export const AUTH_FNS = new Set(['auth.uid', 'auth.jwt', 'auth.role']);
/** Role helpers called with the caller's uid: wrapped only when every argument is row-free. */
export const UID_HELPERS = new Set([
  'public.has_role', 'public.is_admin_or_manager', 'public.is_internal_staff', 'public.is_business_owner',
]);
/** Argument-less helpers that read auth.uid() inside. */
export const ZERO_ARG_HELPERS = new Set(['public.get_my_affiliate_id']);
/** Every function this rewrite may wrap. The generator refuses if one of them is VOLATILE. */
export const WRAPPABLE = new Set([...AUTH_FNS, ...UID_HELPERS, ...ZERO_ARG_HELPERS]);

// ── lexing helpers (deparsed SQL: '…' literals with '' escapes, "…" identifiers) ──────────────

function skipQuoted(s, i) {
  const q = s[i];
  let j = i + 1;
  for (;;) {
    if (j >= s.length) throw new Error(`unterminated ${q} at ${i}: ${s}`);
    if (s[j] === q) { if (s[j + 1] === q) { j += 2; continue; } return j + 1; }
    j++;
  }
}

/** Index of the ')' that closes the '(' at `open`. */
export function matchParen(s, open) {
  if (s[open] !== '(') throw new Error(`no '(' at ${open}`);
  let depth = 0;
  for (let i = open; i < s.length;) {
    const c = s[i];
    if (c === "'" || c === '"') { i = skipQuoted(s, i); continue; }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  throw new Error(`unbalanced parentheses: ${s}`);
}

/** Top-level comma split (outside parentheses, brackets and quotes). */
export function splitTopLevel(s) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length;) {
    const c = s[i];
    if (c === "'" || c === '"') { i = skipQuoted(s, i); continue; }
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(s.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(s.slice(start));
  return parts;
}

const CALL_RE = /^([a-z_][a-z0-9_]*)\.([a-z_][a-z0-9_]*)\(/;
const IDENT_CHAR = /[A-Za-z0-9_$."]/;

/** A schema-qualified call starting at i: { name, open, close, args } or null. */
function callAt(s, i) {
  if (i > 0 && IDENT_CHAR.test(s[i - 1])) return null;
  const m = CALL_RE.exec(s.slice(i, i + 130));
  if (!m) return null;
  const open = i + m[0].length - 1;
  const close = matchParen(s, open);
  return { name: `${m[1]}.${m[2]}`, open, close, args: s.slice(open + 1, close) };
}

/**
 * A scalar sub-select wrapping exactly one wrappable call — `( SELECT auth.uid() AS uid)` as
 * pg_get_expr prints it, or `(SELECT auth.uid())` as this generator writes it — starting at i.
 * Returns { close, call } (call = the inner call text) or null.
 */
export function wrapperAt(s, i) {
  if (s[i] !== '(') return null;
  const m = /^\(\s*SELECT\s+/.exec(s.slice(i, i + 16));
  if (!m) return null;
  const close = matchParen(s, i);
  let body = s.slice(i + m[0].length, close).trimEnd();
  const alias = / AS [a-z_][a-z0-9_]*$/.exec(body);
  if (alias) body = body.slice(0, alias.index);
  const c = callAt(body, 0);
  if (!c || c.close !== body.length - 1 || !WRAPPABLE.has(c.name)) return null;
  if (UID_HELPERS.has(c.name) && !splitTopLevel(c.args).every(isRowFree)) return null;
  return { close, call: body };
}

const LITERAL_RE = /^'(?:[^']|'')*'(?:::[a-z_][a-z0-9_.]*(?:\[\])?)?$/i;

/** True when an argument cannot depend on the row: an auth.* call (bare or wrapped) or a constant. */
export function isRowFree(arg) {
  const a = arg.trim();
  if (/^auth\.(uid|jwt|role)\(\)$/.test(a)) return true;
  if (a.startsWith('(')) { const w = wrapperAt(a, 0); if (w && w.close === a.length - 1) return isRowFree(w.call); }
  return LITERAL_RE.test(a) || /^-?\d+(\.\d+)?$/.test(a) || /^NULL(::[a-z_][a-z0-9_.]*)?$/i.test(a);
}

/**
 * Rewrite one expression. Returns { text, changed, wrapped: [call names], notes: [strings] }.
 * Everything that is not a per-row wrappable call is copied byte for byte.
 */
export function rewriteExpr(src) {
  if (src == null) return { text: src, changed: false, wrapped: [], notes: [] };
  const wrapped = [];
  const notes = [];
  const rw = (s) => {
    let out = '';
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === "'" || ch === '"') { const j = skipQuoted(s, i); out += s.slice(i, j); i = j; continue; }
      if (ch === '(') {
        const w = wrapperAt(s, i);
        if (w) { out += s.slice(i, w.close + 1); i = w.close + 1; continue; }   // already an InitPlan
      }
      const c = callAt(s, i);
      if (c) {
        if ((AUTH_FNS.has(c.name) || ZERO_ARG_HELPERS.has(c.name)) && c.args.trim() === '') {
          out += `(SELECT ${c.name}())`;
          wrapped.push(c.name);
          i = c.close + 1;
          continue;
        }
        if (UID_HELPERS.has(c.name)) {
          if (splitTopLevel(c.args).every(isRowFree)) {
            out += `(SELECT ${c.name}(${rw(c.args)}))`;
            wrapped.push(c.name);
          } else {
            notes.push(`${c.name}(${c.args}) has a row-dependent argument — left per-row`);
            out += `${c.name}(${rw(c.args)})`;
          }
          i = c.close + 1;
          continue;
        }
        if (!WRAPPABLE.has(c.name)) notes.push(`unknown function ${c.name}() — copied unchanged`);
        // anything else: copy the name and the '(' and keep scanning inside the arguments
        out += s.slice(i, c.open + 1);
        i = c.open + 1;
        continue;
      }
      out += ch;
      i++;
    }
    return out;
  };
  const text = rw(src);
  return { text, changed: text !== src, wrapped, notes };
}

/**
 * Remove every InitPlan wrapper of a wrappable call: `( SELECT x AS a)` / `(SELECT x)` → `x`.
 * normalise(old) === normalise(new) is the structural proof that only wrappers were added.
 */
export function normalise(src) {
  if (src == null) return src;
  const nz = (s) => {
    let out = '';
    for (let i = 0; i < s.length;) {
      const ch = s[i];
      if (ch === "'" || ch === '"') { const j = skipQuoted(s, i); out += s.slice(i, j); i = j; continue; }
      if (ch === '(') {
        const w = wrapperAt(s, i);
        if (w) { out += nz(w.call); i = w.close + 1; continue; }
      }
      out += ch;
      i++;
    }
    return out;
  };
  return nz(src);
}

/** What pg_get_expr() will print for our `(SELECT x)` wrappers (used for messages only). */
export function predictDeparse(text) {
  if (text == null) return text;
  let out = '';
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === "'" || ch === '"') { const j = skipQuoted(text, i); out += text.slice(i, j); i = j; continue; }
    if (text.startsWith('(SELECT ', i)) {
      const w = wrapperAt(text, i);
      if (w) {
        const name = callAt(w.call, 0).name.split('.')[1];
        out += `( SELECT ${predictDeparse(w.call)} AS ${name})`;
        i = w.close + 1;
        continue;
      }
    }
    out += ch;
    i++;
  }
  return out;
}

/** True when the expression still holds a wrappable call that runs per row. */
export const hasPerRowCall = (expr) => expr != null && rewriteExpr(expr).changed;

// ── the SQL twin of normalise(), used by the migration's drift guard ───────────────────────────
// Whitespace is collapsed first (a CRLF checkout of the migration must still match), then the
// auth wrappers and the helper wrappers are removed. scripts/gen-rls-initplan.mjs checks that
// this SQL and normalise() agree on every live policy before it writes the migration.
export const sqlNormaliseExpr = (e) => String.raw`regexp_replace(
           regexp_replace(
             regexp_replace(${e}, '\s+', ' ', 'g'),
             '\( ?SELECT (auth\.(uid|jwt|role)\(\))( AS [a-z_]+)?\)', '\1', 'g'),
           '\( ?SELECT (public\.[a-z_]+\((?:[^()'']|\(\)|''(?:[^'']|'''')*'')*\))( AS [a-z_]+)?\)', '\1', 'g')`;

// ── the Macedonian Management API client (read-only + as-a-user read-only) ────────────────────

// The target comes from ./target.mjs (03.10.2026, the move to the new project): config.toml, or ELYON_TARGET_REF
// during the move; Bulgaria and retired refs are refused there. ELYON_DOTENV still names another dotenv file.
import { REF, TARGET, FORBIDDEN_REFS, targetEnv } from './target.mjs';
export { REF };
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function loadToken() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const projectId = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (projectId !== REF && !TARGET.overridden) throw new Error(`supabase/config.toml project_id = "${projectId}", expected "${REF}" (Macedonia)`);
  const env = targetEnv();   // ELYON_DOTENV or .env, plus the _NEW keys under the override
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    if (FORBIDDEN_REFS.some((f) => env[k]?.includes(f))) throw new Error(`.env ${k} points at a forbidden project — refusing`);
  }
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN not found (.env, or ELYON_DOTENV=<path to .env>)');
  return env.SUPABASE_ACCESS_TOKEN;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WRITE_WORD = /\b(insert|update|delete|merge|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|vacuum|analy[sz]e|cluster|reindex|refresh|comment|lock|listen|notify|discard|reset|set|begin|commit|rollback|savepoint|into|set_config|nextval|setval|pg_notify|pg_terminate_backend|pg_cancel_backend)\b/i;

/** Literals, quoted identifiers and comments blanked — what remains is the code that runs. */
function codeOnly(sql) {
  return sql.replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

function assertSelect(sql) {
  const code = codeOnly(sql).trim().replace(/;\s*$/, '');
  if (code.includes(';')) throw new Error('refusing SQL: more than one statement');
  if (!/^(select|with|explain)\b/i.test(code)) throw new Error('refusing SQL: only SELECT / WITH / EXPLAIN');
  const body = code.replace(/^explain\s*\([^)]*\)\s*/i, '');
  const w = body.match(WRITE_WORD);
  if (w) throw new Error(`refusing SQL: write keyword "${w[1]}"`);
  if (/^explain/i.test(code) && !/^explain\s*\(([^)]*)\)/i.test(code)) throw new Error('refusing SQL: EXPLAIN needs an option list');
}

export function mkClient() {
  const token = loadToken();
  const scrub = (s) => String(s).split(token).join('***');
  async function post(query, readOnly) {
    for (let attempt = 0; ; attempt++) {
      let res; let text;
      try {
        res = await fetch(`https://api.supabase.com/v1/projects/${REF}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, read_only: readOnly }),
          signal: AbortSignal.timeout(180_000),
        });
        text = await res.text();
      } catch (e) {
        if (attempt < 2) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        throw new Error(`Management API unreachable: ${scrub(e?.message ?? e)}`);
      }
      // 429: the Management API throttles per token (other sessions share it) — back off, up to ~2 min
      if ((res.status === 429 || res.status >= 502) && attempt < 7) { await new Promise((r) => setTimeout(r, Math.min(30_000, 2000 * 2 ** attempt))); continue; }
      if (!res.ok) throw new Error(`Management API ${res.status}: ${scrub(text).slice(0, 600)}`);
      return JSON.parse(text);
    }
  }
  return {
    /** One SELECT, read-only role, with every name printed schema-qualified (search_path ''). */
    async select(sql) {
      assertSelect(sql);
      return post(`set search_path = ''; ${sql}`, true);
    },
    /**
     * One SELECT on the read-only role (RLS bypassed: it sees every row) with a user's JWT claims
     * set, so auth.uid() inside the SELECT returns that user (uid null → no sub → NULL).
     * Returns { rows, ms } or { error, ms }.
     */
    async selectAs(uid, sql, { timeoutS = 110 } = {}) {
      if (uid != null && !UUID_RE.test(uid)) throw new Error(`not a uuid: ${uid}`);
      assertSelect(sql);
      const claims = uid ? JSON.stringify({ sub: uid, role: 'authenticated' }) : '{}';
      const q = `begin read only; set local search_path = ''; set local request.jwt.claims to '${claims}'; `
        + `set local statement_timeout = '${Number(timeoutS) | 0}s'; ${sql}; commit;`;
      const t0 = Date.now();
      try {
        return { rows: await post(q, true), ms: Date.now() - t0 };
      } catch (e) {
        return { error: String(e.message).slice(0, 300), ms: Date.now() - t0 };
      }
    },
    /**
     * One SELECT / EXPLAIN as an authenticated user with RLS ON, inside a READ ONLY transaction
     * (`set local role` is refused to the read-only role, hence read_only:false + BEGIN READ ONLY).
     * Returns { rows, ms } or { error, ms }.
     */
    async asUser(uid, sql, { timeoutS = 60 } = {}) {
      if (!UUID_RE.test(uid)) throw new Error(`not a uuid: ${uid}`);
      assertSelect(sql);
      const claims = JSON.stringify({ sub: uid, role: 'authenticated' });
      const q = `begin read only; set local role authenticated; set local request.jwt.claims to '${claims}'; `
        + `set local statement_timeout = '${Number(timeoutS) | 0}s'; ${sql}; commit;`;
      const t0 = Date.now();
      try {
        const rows = await post(q, false);
        return { rows, ms: Date.now() - t0 };
      } catch (e) {
        return { error: String(e.message).slice(0, 300), ms: Date.now() - t0 };
      }
    },
  };
}
