#!/usr/bin/env node
/**
 * Tripwire — run before ANY state-changing command (db push, functions deploy,
 * secrets set, vercel deploy).
 *
 * Why this exists: the SUPABASE_ACCESS_TOKEN in .env has write access to BOTH
 * this project and the live Bulgarian CRM. An explicit `--project-ref` OVERRIDES
 * the local link, so nothing but the command line protects Bulgaria. This has
 * already caused one live BG outage (2026-06-30).
 *
 * Exits 0 only if every local config agrees we are pointed at Macedonia, and the
 * remote database looks like Macedonia rather than Bulgaria.
 *
 *   node scripts/assert-mk-target.mjs
 *
 * The remote check is a PHONE-CODE fingerprint, not a row count. Bulgaria stores
 * customer phones as +359…, Macedonia as +389… (normalizeMkPhone can only ever
 * emit +389), so the split is definitive and — unlike a row-count ceiling — it
 * does not decay as Macedonia grows. The old 50k ceiling would have started
 * screaming "LIVE BULGARIA" the moment the 81,657-order AlterCPA history landed
 * on 2026-08-05, which is exactly when you least want your tripwire crying wolf.
 * An absolute ceiling is kept as a second net, well above any plausible MK size.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The target ref comes from scripts/lib/target.mjs (03.10.2026, the move to the new project): config.toml, or
// ELYON_TARGET_REF when a script is aimed at the other Macedonian project during the move. Bulgaria is
// refused there at import time; a retired ref too.
import { TARGET, REF as EXPECTED_REF, BG_REF as FORBIDDEN_REF, KNOWN_MK_REFS, FORBIDDEN_REFS, targetEnv } from './lib/target.mjs';
const EXPECTED_VERCEL = 'elyon-natura';  // renamed from elyon-macedonia 2026-08-01
const EXPECTED_VERCEL_PROJECT = 'prj_cwxmm4jb74hUHmAb6YzbUG7PuDy3';
// The elyoncoding Pro team "elyon-s-projects" since 02.10.2026 — the BG elyoncrm lives on another team.
const EXPECTED_VERCEL_ORG = 'team_fT756uoO13MD9jtimyq27JNy';
const FORBIDDEN_VERCEL_PROJECT = 'prj_965V2iBg793RmiJJw9m6Tl3djllX'; // live Bulgaria (elyoncrm)
const MAX_ORDERS = Number(process.env.MK_MAX_ORDERS || 1_000_000);
const MAX_BG_PHONE_SHARE = 0.20;   // MK data is +389; a fifth in +359 means wrong database

const fail = (msg) => { console.error(`\x1b[31m✗ ABORT\x1b[0m  ${msg}`); process.exit(1); };
const ok = (msg) => console.log(`\x1b[32m✓\x1b[0m ${msg}`);

function readEnv() {
  const env = { ...process.env };
  try {
    for (const line of readFileSync(join(root, '.env'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
      if (m && !env[m[1]]) env[m[1]] = m[2];
    }
  } catch { /* .env optional when vars already exported */ }
  return env;
}

// 1 — supabase/config.toml is what `--linked` resolves to.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const projectId = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (FORBIDDEN_REFS.includes(projectId) || !KNOWN_MK_REFS.includes(projectId))
  fail(`supabase/config.toml project_id = "${projectId}" is not a Macedonian project`);
if (!TARGET.overridden && projectId !== EXPECTED_REF) fail(`supabase/config.toml project_id = "${projectId}", expected "${EXPECTED_REF}"`);
ok(`config.toml → ${projectId}${TARGET.overridden ? `  (target overridden → ${EXPECTED_REF})` : ''}`);

// 2 — .env must agree, or a script reading it will diverge from the CLI. (With the override, the _NEW keys.)
const env = TARGET.overridden ? targetEnv() : readEnv();
if (env.VITE_SUPABASE_PROJECT_ID && env.VITE_SUPABASE_PROJECT_ID !== EXPECTED_REF)
  fail(`.env VITE_SUPABASE_PROJECT_ID = "${env.VITE_SUPABASE_PROJECT_ID}", expected "${EXPECTED_REF}"`);
for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL']) {
  if (env[k] && !env[k].includes(EXPECTED_REF)) fail(`.env ${k} does not point at ${EXPECTED_REF}: ${env[k]}`);
  if (env[k] && env[k].includes(FORBIDDEN_REF)) fail(`.env ${k} points at LIVE BULGARIA`);
}
ok('.env agrees');

// 3 — Vercel link.
try {
  const vp = JSON.parse(readFileSync(join(root, '.vercel', 'project.json'), 'utf8'));
  if (vp.projectId === FORBIDDEN_VERCEL_PROJECT) fail('.vercel/project.json points at LIVE BULGARIA (elyoncrm)');
  if (vp.projectName !== EXPECTED_VERCEL) fail(`.vercel/project.json projectName = "${vp.projectName}", expected "${EXPECTED_VERCEL}"`);
  if (vp.projectId !== EXPECTED_VERCEL_PROJECT) fail(`.vercel/project.json projectId = "${vp.projectId}", expected "${EXPECTED_VERCEL_PROJECT}"`);
  if (vp.orgId !== EXPECTED_VERCEL_ORG)
    fail(`.vercel/project.json orgId = "${vp.orgId}", expected the Pro team "${EXPECTED_VERCEL_ORG}" (elyon-s-projects)`);
  ok(`vercel → ${vp.projectName} on elyon-s-projects`);
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  console.log('· .vercel/project.json absent (skipped)');
}

// 4 — Remote identity. Local files can all be right while the CLI is aimed elsewhere,
//     so confirm against the database we would actually write to.
const token = env.SUPABASE_ACCESS_TOKEN;
if (!token) fail('SUPABASE_ACCESS_TOKEN missing — cannot verify the remote target');

const res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    query: `select (select count(*) from public.orders)::int as orders,
                   (select count(*) from public.orders where customer_phone like '+359%')::int as bg_phones,
                   current_database() as db;`,
  }),
});
if (!res.ok) fail(`Management API query failed: ${res.status} ${await res.text()}`);
const [row] = await res.json();
if (row.orders > MAX_ORDERS)
  fail(`remote has ${row.orders} orders (ceiling ${MAX_ORDERS}). This does not look like Macedonia.`);
const bgShare = row.orders ? row.bg_phones / row.orders : 0;
if (bgShare > MAX_BG_PHONE_SHARE)
  fail(`remote has ${row.bg_phones} of ${row.orders} orders on +359 phones (${(bgShare * 100).toFixed(1)}%). This looks like LIVE BULGARIA, not Macedonia.`);
ok(`remote ${EXPECTED_REF} reachable — ${row.orders} orders, ${row.bg_phones} on +359 (${(bgShare * 100).toFixed(1)}%, ceiling ${MAX_BG_PHONE_SHARE * 100}%)`);

console.log('\n\x1b[32mTarget confirmed: Macedonia.\x1b[0m Safe to proceed.\n');
