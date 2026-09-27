#!/usr/bin/env node
/**
 * Seed the sales people, their identities and their teams (migration 20260935000100).
 *
 *   node scripts/seed-sales-people.mjs                    # DRY RUN: plan + CSVs in exports/attribution/
 *   node scripts/seed-sales-people.mjs --apply            # write the plan — ONE transaction, idempotent
 *   node scripts/seed-sales-people.mjs --link "Адела Нуманович=Adela Numanovikj"
 *   node scripts/seed-sales-people.mjs --include-inactive-with-activity
 *
 * ── Who becomes a person ─────────────────────────────────────────────────────
 *   0. every login in OWNER_IDENTITY_MAP — whatever its status or roles (an
 *      inactive login is seeded with is_active = false).
 *   1. every ACTIVE CRM profile holding agent / pending_agent / prediction_agent
 *      (admins hold all three — the management people come in this way). Test
 *      logins are skipped. Two logins with the SAME name are one human: the
 *      owner-mapped login (else the one that has worked) becomes the person's
 *      user_id, the other is reported (its confirmations still resolve by name).
 *      --include-inactive-with-activity also seeds deactivated logins that did
 *      CRM work since 2026-08-01 (is_active = false, no team).
 *   2. every AlterCPA operator in scripts/data/altercpa-operators.json that
 *      appears in the MK ledger since 2026-08-01 (payload app / user), plus
 *      every id in OWNER_IDENTITY_MAP even when its work predates the ledger,
 *   3. plus ledger ids nobody has named — "AlterCPA #4531 (unnamed)".
 *
 * ── Linking ──────────────────────────────────────────────────────────────────
 * FIRST the owner-confirmed map (OWNER_IDENTITY_MAP, Mile 2026-09-27): each
 * AlterCPA id there belongs to the person behind that CRM login. Authoritative:
 * applied before any fold logic, and no --link can override it.
 * THEN the fold, for everyone else: an AlterCPA operator is linked to a CRM
 * person when agentIdentityKey() — an exact copy of the api edge function's
 * fold (supabase/functions/api/index.ts ~1109-1160; keep in step,
 * scripts/audit-agent-identity-merge.mjs guards the rulings) — of the two names
 * is EQUAL and matches exactly one CRM person. Operator ruling 2026-08-14:
 * merge the same name across scripts, and ONLY that. So nothing looser is ever
 * applied automatically: near-misses (a Serbian -ić vs Macedonian -иќ surname
 * ending, a middle initial, a given name alone, one letter off) are printed as
 * PROPOSED links with the exact --link flag to add once the owner confirms.
 *   --link "altercpa:<id>=<CRM person>"   merge an AlterCPA operator into a CRM person
 *   --link "<spelling>=<person>"          name an order/collabBox spelling for a person
 * <person> is `login:<email>`, or a name matched exactly first, then by fold,
 * and must be unique.
 *
 * ── Identities ───────────────────────────────────────────────────────────────
 *   altercpa_user     every AlterCPA id → its person (with the ledger account)
 *   order_name        every orders.confirmed_by_name / assigned_agent_name
 *                     spelling (non-collabBox) whose fold names exactly ONE
 *                     person, plus each person's own names
 *   collabbox_author  the same for confirmed_by_name on collabBox orders
 * SQL then matches these values EXACTLY (spaces and all) — never a fold.
 *
 * ── Teams — the roster Mile confirmed on 2026-09-27 (editable later) ────────
 * valid_from = the owner's date when the roster gives one; otherwise the
 * person's first activity in the data (CRM order_history / AlterCPA ledger),
 * never before 2026-08-01, and 2026-08-01 when there is none. valid_to = the
 * owner's date; an inactive person without one is closed on their last
 * activity day, so their history still attributes to them.
 * Management: is_manager = true (shown, never earns).
 *
 * ── Apply ────────────────────────────────────────────────────────────────────
 * One implicit transaction (no explicit BEGIN — an error rolls everything back
 * and leaves the API connection clean). Idempotent: an existing person is found
 * by login, by AlterCPA id, or (no login) by exact display name, and is never
 * modified; identities are ON CONFLICT DO NOTHING (a handle already naming a
 * DIFFERENT person is reported, never moved); a membership is added only when
 * the person has no overlapping primary membership. After the seed, the
 * Settings → Teams screen owns every edit.
 *
 * 🛑 MACEDONIA ONLY (same guards as scripts/lib/repair-kit.mjs). The token is
 * never printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MK_REF = 'bmfxhgznttcnnlqloqzp';
const BG_REF = 'sxymaloycddnoxudxaqp'; // live Bulgaria — never a target, never touched
const EXPORT_DIR = join(ROOT, 'exports', 'attribution');
const OPERATORS_JSON = join(ROOT, 'scripts', 'data', 'altercpa-operators.json');
const SINCE = '2026-08-01';
const AGENT_ROLES = new Set(['agent', 'pending_agent', 'prediction_agent']);

// ── The roster Mile confirmed on 2026-09-27 (updated late evening) ───────────
// An entry is a name (resolved through the fold, so "Snezana" finds the
// "Snezhana" login), `login:<email>` or `altercpa:<id>` — or an object
// { ref, valid_from?, valid_to? } where the owner gave the dates (valid_to is
// the LAST day, inclusive).
export const ROSTER = {
  crm_prediction: [
    'Ruzhica Parizovska', 'Frosina Ivanovska', 'Emira Jusufi', 'Stanka Jovanovska', 'Aida Kajevikj',
    'Katerina Bakardzieva', 'Maja Stankovska', 'Elvira Shakirovikj', 'Adela Numanovikj', 'Julijana Andonovska',
    'Anita Koligova', 'Valentina Docevska', 'Sonja Taseva', 'Liljana Ristovska', 'Marija Trajkovska',
    'Marija Temelkovska', 'Tamara Radovikj', 'Zhaklina Bogatinova',
  ],
  altercpa_leads: [
    'Aleksandra Hristoska', 'Slobodanka Petrova', 'login:zaklina.d@naturatherapy.mk', 'Snezana Stojkovska',
    'login:iva@naturatherapy.mk', 'Saska Simonovska', 'login:sanela@naturatherapy.mk', 'Elena Mladenovska',
    'Martina Bundova',
    // A pending agent who sometimes works predictions (moved from crm_prediction).
    'login:kristina.d@naturatherapy.mk',
    // Inactive logins: memberships closed on the owner's dates.
    { ref: 'login:marija.m@naturatherapy.mk', valid_to: '2026-08-29' },
    { ref: 'login:teodora.k@naturatherapy.mk', valid_from: '2026-06-27', valid_to: '2026-07-07' },
    'altercpa:4531',
  ],
  management: [
    'Dragana', 'Radislava Maneska', 'Mitrov', 'Dzenet Ramadani', 'Teodora Krstevska', 'Mile Stoev',
    'Hedi', 'Nina', 'Mr Tony',
    'login:kalina@naturatherapy.mk',   // Kalina — supervisor
  ],
};

// ── Owner-confirmed identity map (Mile, 2026-09-27 late evening) ─────────────
// AUTHORITATIVE. Applied before any fold logic: each AlterCPA id is an identity
// of the person behind that CRM login. The login is seeded even when inactive
// or without an agent role; the id even when it has no MK ledger rows since
// 2026-08-01. A --link can never override an entry here.
export const OWNER_IDENTITY_MAP = [
  { altercpa: 3835, login: 'zaklina.d@naturatherapy.mk', note: 'Zaklina Denik — own login since 2026-09-27' },
  { altercpa: 4170, login: 'marija.m@naturatherapy.mk',  note: 'Marija Markovska — inactive login' },
  { altercpa: 3055, login: 'teodora.k@naturatherapy.mk', note: 'Teodora Kostovska — inactive login; last AlterCPA work 2026-07-07' },
  { altercpa: 4067, login: 'kalina@naturatherapy.mk',    note: 'AlterCPA "Kalina Trajkovska" = login "Kalina Tajkovska" (supervisor)' },
  { altercpa: 4429, login: 'kristina.d@naturatherapy.mk', note: 'Kristina Danevska — proven by collabBox authorship 64/64' },
  { altercpa: 3917, login: 'nina@naturatherapy.mk',      note: 'the CRM admin/owner "Nina" IS AlterCPA "Nina Nedelkovska"' },
  { altercpa: 4134, login: 'iva@naturatherapy.mk',       note: 'Iva Kunoska' },
  { altercpa: 3453, login: 'sashka.s@naturatherapy.mk',  note: 'the working login; sashka@ is the deactivated duplicate' },
  { altercpa: 4375, login: 'sanela@naturatherapy.mk',    note: 'login "Sanela Dzogovikj" = AlterCPA "Sanela Dzogovich"' },
];

// Still open; printed every run.
const OPEN_QUESTIONS = [
  'AlterCPA #4531 is still unknown — stays "AlterCPA #4531 (unnamed)" in the unmapped queue',
];
// Operator rulings 2026-08-14 (Bogatinova ≠ Denik re-confirmed by Mile
// 2026-09-27) — different people. Mirror of MUST_STAY_APART in
// scripts/audit-agent-identity-merge.mjs: never proposed, never linked, and a
// --link (or an owner-map entry) that would merge them is refused.
export const MUST_STAY_APART = [
  ['Teodora Kostovska', 'Teodora Krstevska'],
  ['Zhaklina Bogatinova', 'Zaklina Denik'],
];

// ── agentIdentityKey — EXACT copy of supabase/functions/api/index.ts ─────────
// Keep in step. Lossy on purpose (ц/ч→c, ж/з→z, ш/с→s): the only way
// "Sashka" and "Saska" meet. Different surnames stay different people.
const AGENT_CYR_TO_LAT = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ѓ': 'g', 'е': 'e', 'ж': 'z', 'з': 'z',
  'ѕ': 'd', 'и': 'i', 'ј': 'j', 'к': 'k', 'л': 'l', 'љ': 'l', 'м': 'm', 'н': 'n', 'њ': 'n',
  'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'ќ': 'k', 'у': 'u', 'ф': 'f', 'х': 'h',
  'ц': 'c', 'ч': 'c', 'џ': 'd', 'ш': 's',
  // Bulgarian/Serbian strays inherited from the fork and from border spellings.
  'й': 'j', 'щ': 'st', 'ъ': 'a', 'ь': 'j', 'ю': 'u', 'я': 'a', 'ы': 'i', 'э': 'e', 'ё': 'e',
  'ђ': 'd', 'ћ': 'c', 'ѐ': 'e', 'ѝ': 'i',
};
const AGENT_LATIN_DIGRAPHS = [
  ['dzh', 'd'], ['zh', 'z'], ['sh', 's'], ['ch', 'c'], ['dz', 'd'],
  ['gj', 'g'], ['kj', 'k'], ['lj', 'l'], ['nj', 'n'], ['ts', 'c'],
];
export function normAgentName(raw) {
  let n = String(raw || '').trim().replace(/\s+/g, ' ');
  if (!n) return 'Unknown operator';
  n = n.replace(/\s+\p{L}\.?$/u, '').trim(); // strip a trailing single-letter initial
  return n || 'Unknown operator';
}
export function agentIdentityKey(raw) {
  const n = normAgentName(raw);
  if (n === 'Unknown operator') return '';
  let out = n.toLowerCase().split('').map((c) => AGENT_CYR_TO_LAT[c] ?? c).join('');
  out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  out = out.replace(/ç/g, 'c').replace(/đ/g, 'd').replace(/ø/g, 'o');
  for (const [from, to] of AGENT_LATIN_DIGRAPHS) out = out.split(from).join(to);
  return out.replace(/[^a-z]+/g, ' ').trim();
}

// ── Proposals only — NEVER applied without an explicit --link ────────────────
// Looser keys that surface likely same-person pairs for a human to confirm.
const looseKey = (k) => k.split(' ').filter((t) => t.length > 1)          // middle initials
  .map((t) => t.replace(/(ic|ik)$/, 'ik'))                                  // -ić / -ич / -иќ / -ikj
  .join(' ');
function editDistance(a, b) {
  if (a === b) return 0;
  const m = a.length; const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
const APART = new Set(MUST_STAY_APART.flatMap(([a, b]) => {
  const ka = agentIdentityKey(a); const kb = agentIdentityKey(b);
  return [`${ka}|${kb}`, `${kb}|${ka}`];
}));
/** True when two folded keys belong to people the operator ruled different. */
const mustStayApart = (ka, kb) => APART.has(`${ka}|${kb}`);
/** Best proposal for a folded key against the people, or null. */
function propose(key, people) {
  if (!key) return null;
  const lk = looseKey(key);
  const tokens = key.split(' ');
  const hits = [];
  for (const p of people) {
    for (const f of p.folds) {
      if (f === key || mustStayApart(f, key)) continue;
      if (looseKey(f) === lk) { hits.push({ p, why: 'same name up to a -ić/-иќ ending or a middle initial' }); break; }
      const ft = f.split(' ');
      if (ft.length === 1 && tokens.length > 1 && ft[0] === tokens[0]) { hits.push({ p, why: `given name only ("${f}")` }); break; }
      // Same shape, one name part identical, at most 2 letters apart in total:
      // "Kalina Tajkovska" ~ "Kalina Trajkovska", "Miljana" ~ "Milijana Todorovska".
      if (tokens.length > 1 && ft.length === tokens.length && ft.some((t, i) => t === tokens[i]) && editDistance(f, key) <= 2) {
        hits.push({ p, why: `${editDistance(f, key)} letter(s) apart ("${f}")` }); break;
      }
    }
  }
  const uniq = [...new Map(hits.map((h) => [h.p.k, h])).values()];
  return uniq.length === 1 ? uniq[0] : (uniq.length > 1 ? { ambiguous: uniq } : null);
}

// ── console ──────────────────────────────────────────────────────────────────
const paint = (code) => (s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const red = paint(31); const green = paint(32); const yellow = paint(33); const cyan = paint(36); const bold = paint(1); const dim = paint(90);
const num = (n) => Number(n ?? 0).toLocaleString('de-DE');

class Refusal extends Error {}
const refuse = (m) => { throw new Refusal(m); };

// ── Guard + Management API (CLI only; tests inject their own sql) ────────────
export function mkApi() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (ref !== MK_REF) refuse(`supabase/config.toml project_id = "${ref}", expected "${MK_REF}" — refusing.`);
  if (toml.includes(BG_REF)) refuse('supabase/config.toml mentions the LIVE BULGARIAN project — refusing.');
  let envText = '';
  try { envText = readFileSync(join(ROOT, '.env'), 'utf8'); } catch { /* .env optional when exported */ }
  if (envText.includes(BG_REF)) refuse('.env mentions the LIVE BULGARIAN project — refusing.');
  const env = {};
  for (const line of envText.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    const v = process.env[k] || env[k];
    if (v && v.includes(BG_REF)) refuse(`${k} points at LIVE BULGARIA — refusing.`);
    if (v && !v.includes(MK_REF)) refuse(`${k} does not point at ${MK_REF} — refusing.`);
  }
  const token = process.env.SUPABASE_ACCESS_TOKEN || env.SUPABASE_ACCESS_TOKEN;
  if (!token) refuse('SUPABASE_ACCESS_TOKEN missing (set it in .env).');
  async function sql(query, { readOnly = false } = {}) {
    const attempts = readOnly ? 4 : 1;
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(`https://api.supabase.com/v1/projects/${MK_REF}/database/query`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
        });
        const text = await res.text();
        if (!res.ok) { const err = new Error(`Management API ${res.status}: ${text.slice(0, 1500)}`); err.status = res.status; throw err; }
        if (!text) return [];
        const json = JSON.parse(text);
        return Array.isArray(json) ? json : [];
      } catch (e) {
        lastErr = e;
        const transient = !e.status || e.status >= 500 || e.status === 429 || e.status === 408;
        if (i < attempts && transient) { await new Promise((r) => setTimeout(r, 1500 * i)); continue; }
        throw e;
      }
    }
    throw lastErr;
  }
  return { sql, sqlRead: (q) => sql(q, { readOnly: true }) };
}

// ── SQL literals ─────────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/\u0000/g, '').replace(/'/g, "''")}'`);
const qUuid = (v) => {
  if (v === null || v === undefined) return 'NULL::uuid';
  if (!UUID_RE.test(String(v))) throw new Error(`not a uuid: ${String(v).slice(0, 60)}`);
  return `'${String(v).toLowerCase()}'::uuid`;
};
const qDate = (v) => (v ? `'${v}'::date` : 'NULL::date');
const qBool = (v) => (v ? 'true' : 'false');

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { apply: false, links: [], includeInactive: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--apply') a.apply = true;
    else if (k === '--include-inactive-with-activity') a.includeInactive = true;
    else if (k === '--link') {
      const v = argv[++i];
      const m = String(v ?? '').match(/^(.+?)=(.+)$/);
      if (!m) refuse(`--link needs "<spelling or altercpa:ID>=<person>", got ${JSON.stringify(v)}`);
      a.links.push({ from: m[1].trim(), to: m[2].trim() });
    } else if (k === '--help' || k === '-h') a.help = true;
    else refuse(`unknown argument ${k}`);
  }
  return a;
}

// ── load ─────────────────────────────────────────────────────────────────────
async function load(sqlRead) {
  const profiles = await sqlRead(`
    SELECT p.user_id::text AS user_id, p.full_name, p.email, p.is_active, p.last_seen_at,
           coalesce(array_agg(ur.role::text ORDER BY ur.role::text) FILTER (WHERE ur.role IS NOT NULL), '{}') AS roles,
           (SELECT count(*) FROM public.order_history h WHERE h.changed_by = p.user_id)::int AS actions,
           (SELECT count(*) FROM public.order_history h WHERE h.changed_by = p.user_id AND h.changed_at >= '${SINCE}')::int AS actions_since,
           (SELECT (min(h.changed_at) AT TIME ZONE 'Europe/Skopje')::date::text
              FROM public.order_history h WHERE h.changed_by = p.user_id AND h.changed_at >= '${SINCE}') AS first_day,
           (SELECT (max(h.changed_at) AT TIME ZONE 'Europe/Skopje')::date::text
              FROM public.order_history h WHERE h.changed_by = p.user_id) AS last_day
      FROM public.profiles p
      LEFT JOIN public.user_roles ur ON ur.user_id = p.user_id
     GROUP BY p.user_id, p.full_name, p.email, p.is_active, p.last_seen_at;`);
  const operators = await sqlRead(`
    WITH t AS (
      SELECT l.account_id, coalesce(l.created_remote, l.first_seen_at) AS at,
             CASE WHEN (l.payload ->> 'app')  ~ '^[0-9]{1,9}$' THEN (l.payload ->> 'app')::int  END AS app,
             CASE WHEN (l.payload ->> 'user') ~ '^[0-9]{1,9}$' THEN (l.payload ->> 'user')::int END AS usr
        FROM public.altercpa_leads l
       WHERE upper(coalesce(l.geo, '')) = 'MK'
         AND coalesce(l.created_remote, l.first_seen_at) >= '${SINCE}'
    ), u AS (
      SELECT account_id, at, app AS id FROM t WHERE app > 0
      UNION ALL
      SELECT account_id, at, usr FROM t WHERE usr > 0
    )
    SELECT account_id::text AS account_id, id AS altercpa_user, count(*)::int AS rows,
           (min(at) AT TIME ZONE 'Europe/Skopje')::date::text AS first_day,
           (max(at) AT TIME ZONE 'Europe/Skopje')::date::text AS last_day
      FROM u GROUP BY 1, 2 ORDER BY rows DESC;`);
  const spellings = await sqlRead(`
    SELECT name, kind, sum(n)::int AS n FROM (
      SELECT confirmed_by_name AS name,
             CASE WHEN external_source = 'collabbox' THEN 'collabbox_author' ELSE 'order_name' END AS kind,
             count(*) AS n
        FROM public.orders WHERE confirmed_by_name IS NOT NULL GROUP BY 1, 2
      UNION ALL
      SELECT assigned_agent_name,
             CASE WHEN external_source = 'collabbox' THEN 'collabbox_author' ELSE 'order_name' END,
             count(*)
        FROM public.orders WHERE assigned_agent_name IS NOT NULL GROUP BY 1, 2
    ) t WHERE btrim(name) <> '' GROUP BY 1, 2 ORDER BY 3 DESC;`);
  // The account an owner-mapped id belongs to when it has no MK ledger row.
  const accounts = await sqlRead(`
    SELECT a.id::text AS id, a.name,
           (SELECT count(*) FROM public.altercpa_leads l
             WHERE l.account_id = a.id AND upper(coalesce(l.geo, '')) = 'MK')::int AS mk_leads
      FROM public.altercpa_accounts a;`);
  const [flags] = await sqlRead(`
    SELECT to_regclass('public.sales_people') IS NOT NULL AS has_people,
           to_regclass('public.sales_person_identities') IS NOT NULL AS has_identities,
           to_regclass('public.sales_team_members') IS NOT NULL AS has_members,
           to_regclass('public.sales_teams') IS NOT NULL AS has_teams;`);
  let existing = { people: [], identities: [], members: [], teams: [] };
  if (flags?.has_people && flags?.has_identities && flags?.has_members && flags?.has_teams) {
    existing = {
      people: await sqlRead(`SELECT id::text, display_name, user_id::text, is_manager FROM public.sales_people;`),
      identities: await sqlRead(`SELECT person_id::text, kind, account_id::text, value FROM public.sales_person_identities;`),
      members: await sqlRead(`SELECT person_id::text, team_key, valid_from::text, valid_to::text, is_primary FROM public.sales_team_members;`),
      teams: await sqlRead(`SELECT key FROM public.sales_teams;`),
    };
  }
  return { profiles, operators, spellings, accounts, schemaReady: !!(flags?.has_people && flags?.has_identities && flags?.has_members && flags?.has_teams), existing };
}

const minDay = (a, b) => (!a ? b || null : !b ? a : (a < b ? a : b)); // 'YYYY-MM-DD' strings
const maxDay = (a, b) => (!a ? b || null : !b ? a : (a > b ? a : b));
const lower = (s) => String(s ?? '').trim().toLowerCase();
const isTestLogin = (p) => {
  const local = String(p.email || '').split('@')[0];
  return /(^|[\s_.-])(test|qa|e2e)([\s_.-]|$)/i.test(p.full_name) || /тест/i.test(p.full_name) || /^(qa-|test|pregled)/i.test(local);
};

// ── plan ─────────────────────────────────────────────────────────────────────
export function buildPlan({ profiles, operators, spellings, accounts = [], existing }, { operatorNames, links = [], includeInactive = false }) {
  const report = { crmSkipped: [], duplicateLogins: [], opLinks: [], opAmbiguous: [], proposals: [], ambiguousSpellings: [],
    unresolved: [], rosterMissing: [], rosterConflicts: [], noTeam: [], linkErrors: [], openQuestions: [...OPEN_QUESTIONS] };
  const people = [];
  const byKey = new Map();
  const addPerson = (p) => { people.push(p); byKey.set(p.k, p); return p; };
  const ownerLogins = new Set(OWNER_IDENTITY_MAP.map((e) => lower(e.login)));

  // 1. CRM people — collapse same-name logins into one human.
  const candidates = [];
  for (const p of profiles) {
    // 0. Owner-mapped logins are people whatever their status or roles.
    if (ownerLogins.has(lower(p.email))) { candidates.push(p); continue; }
    const agentish = (p.roles || []).some((r) => AGENT_ROLES.has(r));
    if (!agentish) continue;
    if (isTestLogin(p)) { report.crmSkipped.push({ name: p.full_name, email: p.email, why: 'test login' }); continue; }
    if (!p.is_active) {
      if (includeInactive && p.actions_since > 0) { candidates.push(p); continue; }
      if (p.actions_since > 0) report.crmSkipped.push({ name: p.full_name, email: p.email, why: `inactive login with ${p.actions_since} CRM actions since ${SINCE} (pass --include-inactive-with-activity to seed)` });
      continue;
    }
    candidates.push(p);
  }
  const byName = new Map();
  for (const p of candidates) {
    const k = normAgentName(p.full_name);
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(p);
  }
  for (const [name, logins] of byName) {
    let chosen = logins;
    if (logins.length > 1) {
      const owned = logins.filter((l) => ownerLogins.has(lower(l.email)));
      const working = logins.filter((l) => l.actions > 0 || l.last_seen_at);
      const pick = owned.length === 1 ? owned : (working.length === 1 ? working : null);
      if (pick) {
        chosen = pick;
        report.duplicateLogins.push({ name, kept: pick[0].email, idle: logins.filter((l) => l !== pick[0]).map((l) => l.email) });
      } else {
        report.duplicateLogins.push({ name, kept: null, idle: [], ambiguous: logins.map((l) => l.email) });
      }
    }
    for (const l of chosen) {
      addPerson({
        k: `crm:${l.user_id}`, isNew: true, id: randomUUID(), display_name: l.full_name, user_id: l.user_id,
        email: l.email, crm_name: l.full_name, is_active: !!l.is_active, altercpa: [], names: new Set([l.full_name]),
        folds: new Set([agentIdentityKey(l.full_name)].filter(Boolean)), first: l.first_day || null, last: l.last_day || null,
        team: null, valid_from: null, valid_to: null, is_manager: false, notes: [],
      });
    }
  }
  const crmPeople = () => people.filter((p) => p.user_id);
  const byLogin = (email) => people.find((p) => p.email && lower(p.email) === lower(email));

  // --link parsing: altercpa links apply to operators, spelling links later.
  const resolvePersonRef = (ref) => {
    if (/^login:/i.test(ref)) {
      const p = byLogin(ref.slice(6));
      return p || { error: `login ${ref.slice(6)} is not a seeded person` };
    }
    const exact = people.filter((p) => p.display_name === ref || p.crm_name === ref || [...p.names].includes(ref));
    if (exact.length === 1) return exact[0];
    const key = agentIdentityKey(ref);
    const byFold = people.filter((p) => p.folds.has(key));
    if (byFold.length === 1) return byFold[0];
    return { error: exact.length + byFold.length ? `"${ref}" matches ${Math.max(exact.length, byFold.length)} people` : `"${ref}" matches no person` };
  };
  const opLinks = new Map(); // altercpa id → target ref
  const spellingLinks = [];
  for (const l of links) {
    const m = l.from.match(/^altercpa:(\d+)$/i);
    if (m) opLinks.set(Number(m[1]), l.to); else spellingLinks.push(l);
  }

  // 2 + 3. AlterCPA operators seen in the MK ledger since SINCE.
  const opsById = new Map();
  for (const o of operators) {
    const e = opsById.get(o.altercpa_user) || { id: o.altercpa_user, rows: 0, first_day: null, last_day: null, account_id: o.account_id };
    e.rows += o.rows;
    e.first_day = minDay(e.first_day, o.first_day);
    if (!e.last_day || (o.last_day && o.last_day > e.last_day)) e.last_day = o.last_day;
    opsById.set(o.altercpa_user, e);
  }
  // A merge the operator ruled out (2026-08-14) is refused, whatever asked for it.
  const apartFrom = (person, key) => [...person.folds].some((f) => mustStayApart(f, key));

  // 2a. The owner-confirmed map FIRST — before any fold. An id with no MK ledger
  // row since SINCE (e.g. Teodora Kostovska, last AlterCPA work 2026-07-07) is
  // still an identity; its account is the one that holds the MK leads.
  const mkAccount = [...accounts].sort((a, b) => (b.mk_leads || 0) - (a.mk_leads || 0))[0]?.id || null;
  const ownerIds = new Set();
  for (const e of OWNER_IDENTITY_MAP) {
    const person = byLogin(e.login);
    if (!person) { report.linkErrors.push(`owner map: login ${e.login} (AlterCPA #${e.altercpa}) is not a profile here`); continue; }
    const op = opsById.get(e.altercpa);
    const name = operatorNames[String(e.altercpa)] || null;
    const key = name ? agentIdentityKey(name) : '';
    if (key && apartFrom(person, key)) {
      report.linkErrors.push(`owner map: AlterCPA #${e.altercpa} ${name} → ${person.display_name} contradicts the 2026-08-14 ruling`);
      continue;
    }
    const account_id = op?.account_id || mkAccount;
    if (!account_id) { report.linkErrors.push(`owner map: no AlterCPA account to hold #${e.altercpa}`); continue; }
    person.altercpa.push({ id: e.altercpa, name, account_id, rows: op?.rows || 0, first_day: op?.first_day || null, last_day: op?.last_day || null });
    if (name) { person.names.add(name); if (key) person.folds.add(key); }
    person.first = minDay(person.first, op?.first_day);
    person.last = maxDay(person.last, op?.last_day);
    person.notes.push(`AlterCPA #${e.altercpa}: ${e.note} (owner-confirmed 2026-09-27)`);
    ownerIds.add(e.altercpa);
    report.opLinks.push({ id: e.altercpa, name, person: person.display_name,
      basis: op ? 'owner map' : `owner map — no MK ledger rows since ${SINCE}` });
  }
  for (const id of opLinks.keys()) {
    if (ownerIds.has(id)) report.linkErrors.push(`--link altercpa:${id}=…: #${id} is fixed by the owner-confirmed map — edit OWNER_IDENTITY_MAP instead`);
  }

  // 2b. Everyone else: --link, then the exact fold.
  const altOnlyByFold = new Map();
  for (const op of [...opsById.values()].sort((a, b) => a.id - b.id)) {
    if (ownerIds.has(op.id)) continue;
    const name = operatorNames[String(op.id)] || null;
    const key = name ? agentIdentityKey(name) : '';
    const entry = { id: op.id, name, account_id: op.account_id, rows: op.rows, first_day: op.first_day, last_day: op.last_day };
    let target = null; let basis = null;
    if (opLinks.has(op.id)) {
      const t = resolvePersonRef(opLinks.get(op.id));
      if (t.error) report.linkErrors.push(`--link altercpa:${op.id}=${opLinks.get(op.id)}: ${t.error}`);
      else if (key && apartFrom(t, key)) report.linkErrors.push(`--link altercpa:${op.id}=${opLinks.get(op.id)}: operator ruling 2026-08-14 — ${name} and ${t.display_name} are different people`);
      else { target = t; basis = 'link'; }
    }
    if (!target && key) {
      const hits = crmPeople().filter((p) => p.folds.has(key) && !apartFrom(p, key));
      if (hits.length === 1) { target = hits[0]; basis = 'fold'; } else if (hits.length > 1) {
        report.opAmbiguous.push({ id: op.id, name, candidates: hits.map((h) => h.display_name) });
      }
    }
    if (!target && key && altOnlyByFold.has(key)) { target = altOnlyByFold.get(key); basis = 'fold (second AlterCPA id)'; }
    if (target) {
      target.altercpa.push(entry);
      if (name) { target.names.add(name); target.folds.add(key); }
      target.first = minDay(target.first, op.first_day);
      target.last = maxDay(target.last, op.last_day);
      report.opLinks.push({ id: op.id, name, person: target.display_name, basis });
      continue;
    }
    const p = addPerson({
      k: `alt:${op.id}`, isNew: true, id: randomUUID(), display_name: name || `AlterCPA #${op.id} (unnamed)`, user_id: null,
      email: null, crm_name: null, is_active: true, altercpa: [entry], names: new Set(name ? [name] : []),
      folds: new Set(key ? [key] : []), first: op.first_day || null, last: op.last_day || null,
      team: null, valid_from: null, valid_to: null, is_manager: false,
      notes: [name ? 'AlterCPA-only operator' : 'AlterCPA id nobody has named yet — unmapped queue'],
    });
    if (key) altOnlyByFold.set(key, p);
  }
  for (const [id, ref] of opLinks) {
    if (!opsById.has(id) && !ownerIds.has(id)) report.linkErrors.push(`--link altercpa:${id}=${ref}: id ${id} does not appear in the MK ledger since ${SINCE}`);
  }

  // Spelling links (after all people exist): pin the spelling AND its fold.
  const pinned = new Map(); // spelling → person
  for (const l of spellingLinks) {
    const t = resolvePersonRef(l.to);
    if (t.error) { report.linkErrors.push(`--link ${l.from}=${l.to}: ${t.error}`); continue; }
    if (apartFrom(t, agentIdentityKey(l.from))) {
      report.linkErrors.push(`--link ${l.from}=${l.to}: operator ruling 2026-08-14 — different people`);
      continue;
    }
    pinned.set(l.from, t);
    t.names.add(l.from);
    const k = agentIdentityKey(l.from);
    if (k) t.folds.add(k);
  }

  // Existing people (a re-run): match by login, AlterCPA id, or exact name.
  const exIdent = existing.identities || [];
  for (const p of people) {
    let ex = null;
    if (p.user_id) ex = (existing.people || []).find((e) => e.user_id === p.user_id);
    if (!ex) {
      for (const a of p.altercpa) {
        const hit = exIdent.find((i) => i.kind === 'altercpa_user' && i.value === String(a.id) && i.account_id === a.account_id);
        if (hit) { ex = (existing.people || []).find((e) => e.id === hit.person_id); if (ex) break; }
      }
    }
    if (!ex && !p.user_id) ex = (existing.people || []).find((e) => !e.user_id && e.display_name === p.display_name);
    if (ex) { p.isNew = false; p.id = ex.id; }
  }

  // 4. Identities.
  const identities = [];
  const seen = new Set();
  const addIdentity = (p, kind, value, account_id, note, orders) => {
    const key = `${kind}|${account_id || ''}|${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    identities.push({ k: p.k, person: p.display_name, kind, value, account_id: account_id || null, note, orders: orders ?? null });
  };
  for (const p of people) for (const a of p.altercpa) addIdentity(p, 'altercpa_user', String(a.id), a.account_id, a.name ? `AlterCPA ${a.name}` : 'AlterCPA (unnamed)', a.rows);
  const personByFold = (key) => people.filter((p) => p.folds.has(key));
  const PLACEHOLDERS = new Set(['import', 'system', 'unknown operator']);
  for (const s of spellings) {
    const raw = s.name;
    if (PLACEHOLDERS.has(String(raw).trim().toLowerCase())) continue;
    if (pinned.has(raw)) { addIdentity(pinned.get(raw), s.kind, raw, null, 'link', s.n); continue; }
    const key = agentIdentityKey(raw);
    if (!key) continue;
    const hits = personByFold(key);
    if (hits.length === 1) { addIdentity(hits[0], s.kind, raw, null, raw === hits[0].crm_name ? 'own name' : 'fold', s.n); continue; }
    if (hits.length > 1) { report.ambiguousSpellings.push({ kind: s.kind, value: raw, orders: s.n, candidates: hits.map((h) => h.display_name) }); continue; }
    const pr = propose(key, people);
    report.unresolved.push({ kind: s.kind, value: raw, orders: s.n, fold: key,
      proposal: pr && !pr.ambiguous ? pr.p.display_name : null, reason: pr ? (pr.ambiguous ? `ambiguous: ${pr.ambiguous.map((h) => h.p.display_name).join(' | ')}` : pr.why) : null });
  }
  for (const p of people) for (const n of p.names) addIdentity(p, 'order_name', n, null, 'own name', null);

  // AlterCPA-only people that look like a CRM person → proposals (never applied).
  for (const p of people.filter((x) => !x.user_id)) {
    for (const f of p.folds) {
      const pr = propose(f, crmPeople());
      if (pr && !pr.ambiguous) {
        report.proposals.push({ from: `altercpa:${p.altercpa.map((a) => a.id).join(',')} ${p.display_name}`, to: pr.p.display_name, why: pr.why,
          flag: `--link "altercpa:${p.altercpa[0].id}=${pr.p.crm_name}"` });
      }
    }
  }
  for (const u of report.unresolved) {
    if (u.proposal) report.proposals.push({ from: `${u.kind} "${u.value}" (${num(u.orders)} orders)`, to: u.proposal, why: u.reason, flag: `--link "${u.value}=${u.proposal}"` });
  }

  // 5. Teams. valid_from: the owner's date, else first activity clamped to
  // SINCE. valid_to: the owner's date; an INACTIVE person without one is closed
  // on their last activity day (or valid_from), never left open.
  const memberships = [];
  const clampDay = (d) => (!d || d < SINCE ? SINCE : d);
  for (const [team, entries] of Object.entries(ROSTER)) {
    for (const entry of entries) {
      const spec = typeof entry === 'string' ? { ref: entry } : entry;
      const ref = spec.ref;
      let p;
      const m = ref.match(/^altercpa:(\d+)$/);
      if (m) p = people.find((x) => x.altercpa.some((a) => a.id === Number(m[1])));
      else { const r = resolvePersonRef(ref); p = r && !r.error ? r : null; }
      if (!p) { report.rosterMissing.push({ team, name: ref }); continue; }
      if (p.team && p.team !== team) { report.rosterConflicts.push({ name: ref, person: p.display_name, kept: p.team, dropped: team }); continue; }
      if (p.team === team) continue;
      const from = spec.valid_from || clampDay(p.first);
      let to = spec.valid_to || null;
      if (!to && !p.is_active) to = p.last && p.last >= from ? p.last : from;
      if (to && to < from) { report.rosterConflicts.push({ name: ref, person: p.display_name, kept: '—', dropped: `${team} (valid_to ${to} before valid_from ${from})` }); continue; }
      p.team = team;
      p.valid_from = from;
      p.valid_to = to;
      if (team === 'management') p.is_manager = true;
      memberships.push({ k: p.k, person: p.display_name, team_key: team, valid_from: from, valid_to: to,
        note: spec.valid_from || spec.valid_to ? 'roster + dates confirmed by Mile 2026-09-27' : 'roster confirmed by Mile 2026-09-27' });
    }
  }
  for (const p of people) if (!p.team) report.noTeam.push({ person: p.display_name, login: p.email, altercpa: p.altercpa.map((a) => a.id).join(',') });

  return { people, identities, memberships, report };
}

// ── output ───────────────────────────────────────────────────────────────────
function writeCsvs(plan, stamp, dir = EXPORT_DIR) {
  mkdirSync(dir, { recursive: true });
  const esc = (v) => { const s = String(v ?? ''); return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const write = (name, cols, rows) => {
    const file = join(dir, `${name}-${stamp}.csv`);
    writeFileSync(file, '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\r\n') + '\r\n');
    return file;
  };
  return [
    write('sales-people', ['display_name', 'status', 'crm_login', 'is_active', 'altercpa_ids', 'team', 'valid_from', 'valid_to', 'is_manager', 'notes'],
      plan.people.map((p) => ({ display_name: p.display_name, status: p.isNew ? 'new' : 'exists', crm_login: p.email || '', is_active: p.is_active,
        altercpa_ids: p.altercpa.map((a) => a.id).join(' '), team: p.team || '', valid_from: p.valid_from || '', valid_to: p.valid_to || '',
        is_manager: p.is_manager, notes: p.notes.join('; ') }))),
    write('sales-identities', ['person', 'kind', 'value', 'orders', 'note'], plan.identities),
    write('sales-review', ['type', 'what', 'orders', 'detail', 'flag'], [
      ...plan.report.proposals.map((r) => ({ type: 'PROPOSED link (not applied)', what: r.from, detail: `${r.to} — ${r.why}`, flag: r.flag })),
      ...plan.report.ambiguousSpellings.map((r) => ({ type: 'ambiguous spelling (not seeded)', what: `${r.kind} "${r.value}"`, orders: r.orders, detail: r.candidates.join(' | ') })),
      ...plan.report.unresolved.map((r) => ({ type: 'unresolved spelling', what: `${r.kind} "${r.value}"`, orders: r.orders, detail: r.proposal ? `proposal: ${r.proposal} (${r.reason})` : (r.reason || '') })),
      ...plan.report.noTeam.map((r) => ({ type: 'person without a team', what: r.person, detail: [r.login, r.altercpa && `AlterCPA ${r.altercpa}`].filter(Boolean).join(' · ') })),
      ...plan.report.crmSkipped.map((r) => ({ type: 'CRM login not seeded', what: r.name, detail: `${r.email} — ${r.why}` })),
      ...plan.report.duplicateLogins.map((r) => ({ type: 'one name, several logins', what: r.name, detail: r.kept ? `kept ${r.kept}; idle ${r.idle.join(', ')}` : `AMBIGUOUS: ${r.ambiguous.join(', ')}` })),
    ]),
  ];
}

function printPlan(plan, log) {
  const { people, identities, memberships, report } = plan;
  log(bold('\n── people ──'));
  const teamOrder = { management: 0, crm_prediction: 1, altercpa_leads: 2 };
  const sorted = [...people].sort((a, b) => (teamOrder[a.team] ?? 9) - (teamOrder[b.team] ?? 9) || a.display_name.localeCompare(b.display_name));
  for (const p of sorted) {
    const alt = p.altercpa.length ? `AlterCPA ${p.altercpa.map((a) => `#${a.id}`).join(' ')}` : '';
    const span = p.team ? `${p.valid_from || ''} → ${p.valid_to || 'open'}` : '';
    log(`  ${(p.isNew ? green('new   ') : dim('exists'))} ${p.display_name.padEnd(24)} ${String(p.team || yellow('— no team')).padEnd(16)} ${span.padEnd(24)} ${p.user_id ? (p.is_active ? 'login     ' : yellow('login OFF ')) : dim('no login  ')} ${alt}${p.is_manager ? cyan('  manager') : ''}`);
  }
  log(`  ${bold(num(people.length))} people (${num(people.filter((p) => p.isNew).length)} new, ${num(people.filter((p) => !p.is_active).length)} inactive) · ${num(identities.length)} identities · ${num(memberships.length)} memberships`);

  log(bold('\n── AlterCPA ↔ CRM links (owner-confirmed map first, then exact fold) ──'));
  for (const l of report.opLinks) log(`  #${String(l.id).padEnd(5)} ${String(l.name ?? '(unnamed)').padEnd(22)} → ${l.person}  ${dim(l.basis)}`);
  for (const a of report.opAmbiguous) log(yellow(`  #${a.id} ${a.name} matches several CRM people (${a.candidates.join(', ')}) — NOT linked`));

  if (report.duplicateLogins.length) {
    log(bold('\n── one name, several logins ──'));
    for (const d of report.duplicateLogins) log(d.kept ? `  ${d.name}: kept ${d.kept} (has worked), idle ${d.idle.join(', ')} — not seeded; its confirmations resolve by name` : yellow(`  ${d.name}: AMBIGUOUS (${d.ambiguous.join(', ')}) — each seeded as its own person; owner to merge`));
  }
  if (report.crmSkipped.length) {
    log(bold('\n── CRM logins not seeded ──'));
    for (const s of report.crmSkipped) log(`  ${s.name} <${s.email}> — ${s.why}`);
  }
  log(bold('\n── still open ──'));
  for (const q2 of report.openQuestions) log(`  • ${q2}`);

  if (report.proposals.length) {
    log(bold('\n── PROPOSED links — NOT applied; add the flag after the owner confirms ──'));
    for (const p of report.proposals) log(`  ${p.from} → ${p.to}  ${dim(`(${p.why})`)}\n      ${cyan(p.flag)}`);
  }
  if (report.ambiguousSpellings.length) {
    log(bold('\n── spellings matching several people (not seeded) ──'));
    for (const a of report.ambiguousSpellings) log(yellow(`  ${a.kind} "${a.value}" (${num(a.orders)}) → ${a.candidates.join(' | ')}`));
  }
  const unres = report.unresolved;
  log(bold(`\n── unresolved spellings: ${num(unres.length)} (${num(unres.reduce((s, u) => s + u.orders, 0))} order rows) — top 25 ──`));
  for (const u of unres.slice(0, 25)) log(`  ${u.kind.padEnd(16)} ${String(u.value).padEnd(30)} ${num(u.orders).padStart(7)}${u.proposal ? dim(`  ~ ${u.proposal}`) : ''}`);
  if (report.rosterMissing.length) {
    log(bold('\n── roster names with no person ──'));
    for (const r of report.rosterMissing) log(red(`  ${r.team}: ${r.name}`));
  }
  if (report.rosterConflicts.length) for (const r of report.rosterConflicts) log(red(`  roster conflict: ${r.name} (${r.person}) is in ${r.kept}; ${r.dropped} dropped`));
  if (report.noTeam.length) {
    log(bold('\n── people without a team (owner to place, or leave) ──'));
    for (const r of report.noTeam) log(`  ${r.person}${r.login ? dim(` <${r.login}>`) : ''}${r.altercpa ? dim(` AlterCPA #${r.altercpa}`) : ''}`);
  }
  if (report.linkErrors.length) for (const e of report.linkErrors) log(red(`  ✗ ${e}`));
}

// ── apply ────────────────────────────────────────────────────────────────────
export function applySql(plan) {
  const P = plan.people.map((p) => `(${q(p.k)}, ${qUuid(p.id)}, ${q(p.display_name)}, ${qUuid(p.user_id)}, ${qBool(p.is_manager)}, ${qBool(p.is_active)}, ${q(p.notes.join('; ') || null)})`);
  const I = plan.identities.map((i) => `(${q(i.k)}, ${q(i.kind)}, ${qUuid(i.account_id)}, ${q(i.value)}, ${q(i.note)})`);
  const M = plan.memberships.map((m) => `(${q(m.k)}, ${q(m.team_key)}, ${qDate(m.valid_from)}, ${qDate(m.valid_to)}, ${q(m.note)})`);
  const ZERO = "'00000000-0000-0000-0000-000000000000'::uuid";
  return `
SET LOCAL statement_timeout = '120s';
SET LOCAL lock_timeout = '10s';

CREATE TEMP TABLE _p (k text PRIMARY KEY, id uuid NOT NULL, display_name text NOT NULL, user_id uuid,
                      is_manager boolean NOT NULL, is_active boolean NOT NULL, notes text) ON COMMIT DROP;
${P.length ? `INSERT INTO _p VALUES\n${P.join(',\n')};` : ''}
CREATE TEMP TABLE _i (k text NOT NULL, kind text NOT NULL, account_id uuid, value text NOT NULL, note text) ON COMMIT DROP;
${I.length ? `INSERT INTO _i VALUES\n${I.join(',\n')};` : ''}
CREATE TEMP TABLE _m (k text NOT NULL, team_key text NOT NULL, valid_from date NOT NULL, valid_to date, note text) ON COMMIT DROP;
${M.length ? `INSERT INTO _m VALUES\n${M.join(',\n')};` : ''}
CREATE TEMP TABLE _stats (k text, n integer) ON COMMIT DROP;

-- A person that already exists (by login, by AlterCPA id, or — without a
-- login — by exact name) keeps its id and is never modified.
UPDATE _p p SET id = coalesce(
    (SELECT sp.id FROM public.sales_people sp WHERE p.user_id IS NOT NULL AND sp.user_id = p.user_id),
    (SELECT x.person_id FROM _i i JOIN public.sales_person_identities x
        ON x.kind = i.kind AND x.account_id = i.account_id AND x.value = i.value
      WHERE i.k = p.k AND i.kind = 'altercpa_user' LIMIT 1),
    (SELECT sp.id FROM public.sales_people sp
      WHERE p.user_id IS NULL AND sp.user_id IS NULL AND sp.display_name = p.display_name LIMIT 1),
    p.id);

WITH ins AS (
  INSERT INTO public.sales_people (id, display_name, user_id, is_manager, is_active, notes)
  SELECT p.id, p.display_name, p.user_id, p.is_manager, p.is_active, p.notes FROM _p p
   WHERE NOT EXISTS (SELECT 1 FROM public.sales_people sp WHERE sp.id = p.id)
  RETURNING 1)
INSERT INTO _stats SELECT 'people_inserted', count(*) FROM ins;

WITH ins AS (
  INSERT INTO public.sales_person_identities (person_id, kind, account_id, value, note)
  SELECT p.id, i.kind, i.account_id, i.value, i.note FROM _i i JOIN _p p ON p.k = i.k
  ON CONFLICT (kind, (coalesce(account_id, ${ZERO})), value) DO NOTHING
  RETURNING 1)
INSERT INTO _stats SELECT 'identities_inserted', count(*) FROM ins;

WITH ins AS (
  INSERT INTO public.sales_team_members (person_id, team_key, valid_from, valid_to, note)
  SELECT p.id, m.team_key, m.valid_from, m.valid_to, m.note FROM _m m JOIN _p p ON p.k = m.k
   WHERE NOT EXISTS (SELECT 1 FROM public.sales_team_members x
                      WHERE x.person_id = p.id AND x.is_primary
                        AND daterange(x.valid_from, x.valid_to, '[]') && daterange(m.valid_from, m.valid_to, '[]'))
  RETURNING 1)
INSERT INTO _stats SELECT 'memberships_inserted', count(*) FROM ins;

SELECT json_build_object(
  'stats', (SELECT json_object_agg(k, n) FROM _stats),
  'identity_conflicts', (SELECT coalesce(json_agg(json_build_object('kind', i.kind, 'value', i.value, 'planned', p.display_name, 'held_by', sp.display_name)), '[]'::json)
                           FROM _i i JOIN _p p ON p.k = i.k
                           JOIN public.sales_person_identities x
                             ON x.kind = i.kind AND coalesce(x.account_id, ${ZERO}) = coalesce(i.account_id, ${ZERO}) AND x.value = i.value
                           JOIN public.sales_people sp ON sp.id = x.person_id
                          WHERE x.person_id <> p.id),
  'memberships_skipped', (SELECT coalesce(json_agg(json_build_object('person', p.display_name, 'team', m.team_key)), '[]'::json)
                            FROM _m m JOIN _p p ON p.k = m.k
                           WHERE NOT EXISTS (SELECT 1 FROM public.sales_team_members x
                                              WHERE x.person_id = p.id AND x.team_key = m.team_key AND x.is_primary))
) AS result;`;
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function run({ sql, sqlRead = (qq) => sql(qq, { readOnly: true }), argv = [], log = console.log, stamp, operatorNames, exportDir = EXPORT_DIR }) {
  const args = parseArgs(argv);
  if (args.help) { log('usage: node scripts/seed-sales-people.mjs [--apply] [--link "a=b"]... [--include-inactive-with-activity]'); return { help: true }; }
  stamp = stamp || new Date().toISOString().replace(/[:.]/g, '-');
  log(bold('\nSales people seed') + ` — ${MK_REF}`);
  log(args.apply ? yellow('MODE: APPLY (writes sales_people / identities / memberships)') : cyan('MODE: dry run (read-only) — pass --apply to write'));
  if (args.links.length) log(`  links: ${args.links.map((l) => `${l.from}=${l.to}`).join(' · ')}`);

  const [fp] = await sqlRead(`SELECT count(*)::int AS n, count(*) FILTER (WHERE customer_phone LIKE '+359%')::int AS bg FROM public.orders;`);
  if (!fp || !fp.n) refuse('The remote has no orders — this is not the Macedonian CRM.');
  if (fp.bg / fp.n > 0.2) refuse(`The remote has ${fp.bg}/${fp.n} orders on +359 phones — this looks like LIVE BULGARIA.`);
  log(`${green('✓')} remote ${MK_REF} — ${num(fp.n)} orders, ${num(fp.bg)} on +359`);

  if (!operatorNames) operatorNames = JSON.parse(readFileSync(OPERATORS_JSON, 'utf8')).operators || {};
  const data = await load(sqlRead);
  if (!data.schemaReady) log(yellow('! migration 20260935000100 is not applied yet — planning against an empty people table'));
  const plan = buildPlan(data, { operatorNames, links: args.links, includeInactive: args.includeInactive });
  printPlan(plan, log);
  const files = writeCsvs(plan, stamp, exportDir);
  log(`\n  CSVs: ${files.join('\n        ')}`);

  if (plan.report.linkErrors.length) refuse('a link (owner-confirmed map or --link) could not be resolved (see above) — nothing written.');
  if (plan.report.rosterMissing.length) log(yellow(`  ! ${plan.report.rosterMissing.length} roster name(s) resolved to no person`));
  if (!args.apply) { log(cyan('\nDry run complete. Review the CSVs, then re-run with --apply.\n')); return { plan }; }

  if (!data.schemaReady) refuse('apply needs migration 20260935000100 (sales_people & co.) — apply it first.');
  const [res] = await sql(applySql(plan));
  const r = res?.result || {};
  log(bold('\n── applied ──'));
  log(`  ${JSON.stringify(r.stats || {})}`);
  for (const c of r.identity_conflicts || []) log(yellow(`  ! ${c.kind} "${c.value}" already names ${c.held_by} (plan: ${c.planned}) — left as is`));
  for (const s of r.memberships_skipped || []) log(yellow(`  ! ${s.person}: not placed in ${s.team} (already has an overlapping primary team)`));
  log(green('\n✓ seeded. Settings → Teams owns every edit from here.\n'));
  return { plan, result: r };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function isMain() {
  if (!process.argv[1]) return false;
  const me = fileURLToPath(import.meta.url);
  const called = resolve(process.argv[1]);
  return process.platform === 'win32' ? me.toLowerCase() === called.toLowerCase() : me === called;
}

if (isMain()) {
  try {
    const api = mkApi();
    await run({ ...api, argv: process.argv.slice(2) });
  } catch (e) {
    console.error(red(`✗ ${e instanceof Refusal ? e.message : (e.stack || e.message || e)}`));
    process.exit(1);
  }
}
