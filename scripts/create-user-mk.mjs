#!/usr/bin/env node
/**
 * Create (or update) a staff login in the MACEDONIAN project.
 *
 *   node scripts/create-user-mk.mjs --email hedi@naturatherapy.mk \
 *        --name "Hedi" --role admin --password '...'
 *
 * The password may also come from CREATE_USER_PASSWORD in the environment, so it
 * need never be written into a file. Nothing here is hard-coded — the reason the
 * older create-*.mjs scripts are a liability is that their passwords live in git.
 *
 * Idempotent: an existing address has its password reset and its role re-asserted
 * rather than being duplicated. Unlike scripts/create-admin-users.mjs and
 * scripts/create-agents-2026-05.mjs, it never DELETEs an existing user.
 *
 * ── Roles ──────────────────────────────────────────────────────────────────
 * "Superadmin" is a DISPLAY LABEL, not a role. The app_role enum has no such
 * value and writing it throws. The highest role is `admin`, which renders as
 * "Суперадмин" in the UI (src/lib/roles.ts) and bypasses every module and
 * permission check. Granting `admin` also fires trg_admin_grant_all_roles, which
 * fans every other role except `affiliate` out to that user — so expect ~8 rows
 * in user_roles, not 1. That is by design.
 *
 * `affiliate` is deliberately not creatable here: affiliate logins belong to
 * external partners and are provisioned through the affiliates admin screen,
 * which keeps them behind the hard wall that bars them from staff surfaces.
 *
 * ── Login ──────────────────────────────────────────────────────────────────
 * The login form appends the placeholder domain ONLY when the input contains no
 * "@" (src/pages/LoginPage.tsx). An address like hedi@naturatherapy.mk is
 * therefore typed IN FULL, even though the field is labelled "Username".
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'bmfxhgznttcnnlqloqzp';

// Every value of public.app_role except 'affiliate' (see above).
const ROLES = [
  'admin', 'manager', 'agent', 'pending_agent', 'prediction_agent',
  'inbound_agent', 'warehouse', 'ads_admin',
];

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : undefined;
};

// Lower-cased at parse time. The older template lower-cased only the remote side
// of the comparison, so a capitalised input silently failed to match an existing
// user and then died on "User already registered".
const EMAIL = arg('email')?.trim().toLowerCase();
const FULL_NAME = arg('name');
const ROLE = arg('role')?.trim().toLowerCase();
const PASSWORD = arg('password') || process.env.CREATE_USER_PASSWORD;

if (!EMAIL || !EMAIL.includes('@')) fail('--email <address> is required (must contain @)');
if (!FULL_NAME) fail('--name "Full Name" is required');
if (!ROLE) fail(`--role <${ROLES.join('|')}> is required`);
if (!ROLES.includes(ROLE)) {
  fail(ROLE === 'superadmin' || ROLE === 'super_admin'
    ? `"${ROLE}" is not a role — it is how the UI labels 'admin'. Use --role admin.`
    : `unknown role "${ROLE}". Valid: ${ROLES.join(', ')}`);
}
if (!PASSWORD) fail('--password <pw> or CREATE_USER_PASSWORD is required');
if (PASSWORD.length < 8) fail('password must be at least 8 characters (the API enforces this too)');

// Guard: never against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL_ = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE) fail('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY');
if (URL_.includes('sxymaloycddnoxudxaqp')) fail('REFUSING: that is Bulgaria.');

async function api(path, method, body) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: {
      apikey: SERVICE, Authorization: `Bearer ${SERVICE}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  return d;
}

console.log(`Target: ${URL_}`);
console.log(`Account: ${EMAIL}  ·  role: ${ROLE}${ROLE === 'admin' ? '  (shown as "Суперадмин")' : ''}\n`);

// ── auth user ──
const list = await api('/auth/v1/admin/users?per_page=200', 'GET');
let user = (list.users || []).find((u) => u.email?.toLowerCase() === EMAIL);

if (user) {
  console.log(`· already exists (${user.id}) — resetting password`);
  // email_confirm keeps the account usable without an outbound email, which
  // matters because no custom SMTP is configured on this project.
  await api(`/auth/v1/admin/users/${user.id}`, 'PUT', { password: PASSWORD, email_confirm: true });
} else {
  user = await api('/auth/v1/admin/users', 'POST', {
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: FULL_NAME },
  });
  console.log(`✓ auth user created: ${user.id}`);
}

// ── profile ── (handle_new_user() normally makes this row; upsert defensively)
const prof = await api(`/rest/v1/profiles?user_id=eq.${user.id}&select=id`, 'GET');
const profile = { full_name: FULL_NAME, email: EMAIL, is_active: true, language: 'mk' };
if (Array.isArray(prof) && prof.length) {
  await api(`/rest/v1/profiles?user_id=eq.${user.id}`, 'PATCH', profile);
  console.log('✓ profile updated (language: mk)');
} else {
  await api('/rest/v1/profiles', 'POST', { user_id: user.id, ...profile });
  console.log('✓ profile created (language: mk)');
}

// ── role ──
const existing = await api(`/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, 'GET');
if (!existing.some((r) => r.role === ROLE)) {
  await api('/rest/v1/user_roles', 'POST', { user_id: user.id, role: ROLE });
  console.log(`✓ role "${ROLE}" assigned`);
} else {
  console.log(`· role "${ROLE}" already present`);
}

const final = await api(`/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, 'GET');
const names = final.map((r) => r.role).sort();
console.log(`\nRoles now held (${names.length}): ${names.join(', ')}`);
if (ROLE === 'admin' && names.length > 1) {
  console.log('  ↑ expected — trg_admin_grant_all_roles fans admin out to every role but affiliate.');
}

console.log(`\nLogin at https://naturall.mk`);
console.log(`  username: ${EMAIL}   ← type the FULL address, it contains an @`);
console.log('  password: (as supplied)');
console.log('\nRecord this account in docs/VAULT.md §3 (gitignored). Rotate the password after first login.');
