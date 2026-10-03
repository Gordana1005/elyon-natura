#!/usr/bin/env node
/**
 * Creates the operator super-admin `mile@elyon.com` in the MACEDONIAN project.
 *
 *   node scripts/create-superadmin-mile.mjs
 *
 * "admin" is the highest role — it bypasses every module/permission check, so
 * this account has full access to every surface.
 *
 * Login note: the login form only appends EMAIL_DOMAIN when the input has no
 * "@". This address contains one, so it is typed in FULL at the login screen
 * (mile@elyon.com), unlike the ...@elyon-mk.local accounts which are typed as
 * a bare username.
 *
 * Idempotent: re-running resets the password and re-asserts the admin role
 * rather than creating a duplicate.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'oufoazmnbwugtfldkwsn';

const EMAIL = 'mile@elyon.com';
const PASSWORD = 'naturatherapy123';
const FULL_NAME = 'Mile Stoev';

// Guard: never against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== EXPECTED_REF) {
  console.error('config.toml does not point at Macedonia — refusing.'); process.exit(1);
}
const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const URL_ = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const SERVICE = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL_ || !SERVICE) { console.error('Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY'); process.exit(1); }
if (URL_.includes('sxymaloycddnoxudxaqp')) { console.error('REFUSING: that is Bulgaria.'); process.exit(1); }

async function api(path, method, body) {
  const res = await fetch(`${URL_}${path}`, {
    method,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const t = await res.text();
  let d; try { d = t ? JSON.parse(t) : null; } catch { d = t; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${typeof d === 'string' ? d : JSON.stringify(d)}`);
  return d;
}

console.log(`Target: ${URL_}`);

// Find or create the auth user.
const list = await api(`/auth/v1/admin/users?per_page=200`, 'GET');
let user = (list.users || []).find((u) => u.email?.toLowerCase() === EMAIL);

if (user) {
  console.log(`· ${EMAIL} already exists (${user.id}) — resetting password`);
  await api(`/auth/v1/admin/users/${user.id}`, 'PUT', { password: PASSWORD, email_confirm: true });
} else {
  user = await api('/auth/v1/admin/users', 'POST', {
    email: EMAIL, password: PASSWORD, email_confirm: true,
    user_metadata: { full_name: FULL_NAME },
  });
  console.log(`✓ auth user created: ${user.id}`);
}

// profiles row — usually created by a trigger on auth.users; upsert defensively.
const prof = await api(`/rest/v1/profiles?user_id=eq.${user.id}&select=id`, 'GET');
if (Array.isArray(prof) && prof.length) {
  await api(`/rest/v1/profiles?user_id=eq.${user.id}`, 'PATCH', { full_name: FULL_NAME, email: EMAIL, is_active: true });
  console.log('✓ profile updated');
} else {
  await api('/rest/v1/profiles', 'POST', { user_id: user.id, full_name: FULL_NAME, email: EMAIL, is_active: true });
  console.log('✓ profile created');
}

// admin role (highest — bypasses every module/permission check).
const roles = await api(`/rest/v1/user_roles?user_id=eq.${user.id}&select=role`, 'GET');
if (!roles.some((r) => r.role === 'admin')) {
  await api('/rest/v1/user_roles', 'POST', { user_id: user.id, role: 'admin' });
  console.log('✓ admin role assigned');
} else {
  console.log('· admin role already present');
}

console.log(`\nLogin at https://naturall.mk`);
console.log(`  email:    ${EMAIL}   (type the FULL address — it contains an @)`);
console.log(`  password: ${PASSWORD}`);
console.log('\nRotate this password once you are in.');
