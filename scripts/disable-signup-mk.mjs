#!/usr/bin/env node
/**
 * Turn OFF public self-registration on the MACEDONIAN Supabase project.
 *
 *   node scripts/disable-signup-mk.mjs            # show current state, change nothing
 *   node scripts/disable-signup-mk.mjs --commit   # set disable_signup = true
 *
 * Why this exists: the audit of 2026-08-04 found GET /auth/v1/settings returning
 * "disable_signup": false on the live project. The publishable key ships in the
 * client bundle, so anyone could POST /auth/v1/signup and land in `authenticated`
 * — the exact trust level several RLS policies grant customer data to. This CRM
 * has no self-service signup path by design; every account is made by an admin.
 *
 * The setting lives in dashboard state, not in the repo, which is how it went
 * unnoticed (docs/SECURITY.md describes the *Bulgarian* project's auth config).
 * Keeping it as a script makes it repeatable and reviewable.
 *
 * Does NOT affect admin-API user creation (scripts/create-user-mk.mjs) — that
 * bypasses the signup endpoint entirely.
 *
 * Rollback: same PATCH with { disable_signup: false }.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const EXPECTED_REF = 'oufoazmnbwugtfldkwsn';
const commit = process.argv.includes('--commit');

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

// Guard: never let this run against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== EXPECTED_REF) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);

const env = {};
for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const token = env.SUPABASE_ACCESS_TOKEN;
const url = env.SUPABASE_URL || env.VITE_SUPABASE_URL;
const anon = env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!token) fail('SUPABASE_ACCESS_TOKEN missing from .env');
if (url?.includes('sxymaloycddnoxudxaqp')) fail('REFUSING: that is Bulgaria.');

const settings = async () => {
  const res = await fetch(`${url}/auth/v1/settings`, { headers: { apikey: anon } });
  if (!res.ok) throw new Error(`settings → ${res.status}`);
  return res.json();
};

console.log(`Target: ${url}`);
const before = await settings();
console.log(`  disable_signup is currently: ${before.disable_signup}`);

if (before.disable_signup === true) {
  console.log('\n\x1b[32mAlready closed. Nothing to do.\x1b[0m');
  process.exit(0);
}

if (!commit) {
  console.log('\n\x1b[33mPublic signup is OPEN.\x1b[0m Re-run with --commit to close it.\n');
  process.exit(0);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/config/auth`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ disable_signup: true }),
});
if (!res.ok) fail(`PATCH config/auth → ${res.status}: ${await res.text()}`);

// GoTrue serves /auth/v1/settings from a cache that lags the config write by a
// few seconds, so poll rather than declaring failure on the first read.
let ok = false;
for (let i = 0; i < 10 && !ok; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  ok = (await settings()).disable_signup === true;
}
if (!ok) fail('PATCH was accepted but /auth/v1/settings still reports disable_signup=false after 20s — check the dashboard.');

console.log('\n\x1b[32m✓ Public signup disabled.\x1b[0m Accounts can now only be created by an admin.');
