#!/usr/bin/env node
/**
 * scripts/with-target.mjs — run any command against ONE Macedonian project.
 *
 *   node scripts/with-target.mjs new -- node scripts/verify-shifts.mjs
 *   node scripts/with-target.mjs old -- node scripts/verify-shifts.mjs
 *
 * Sets ELYON_TARGET_REF (read by scripts/lib/target.mjs) and, for `new`, exports every `KEY_NEW` of .env as
 * `KEY` (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUPABASE_ACCESS_TOKEN, VITE_SUPABASE_*) so that scripts which
 * only read process.env / .env also aim at the new project. Nothing is printed but the target banner.
 */
import { spawnSync } from 'node:child_process';
import { NEW_MK_REF, OLD_MK_REF, BG_REF, readDotenv } from './lib/target.mjs';

const [which, dashdash, ...cmd] = process.argv.slice(2);
if (!['new', 'old'].includes(which) || dashdash !== '--' || !cmd.length) {
  console.error('usage: node scripts/with-target.mjs new|old -- <command> [args]');
  process.exit(2);
}
const ref = which === 'new' ? NEW_MK_REF : OLD_MK_REF;
if (ref === BG_REF) throw new Error('never Bulgaria');
const file = readDotenv();
const env = { ...process.env, ELYON_TARGET_REF: ref };
if (which === 'new') {
  for (const [k, v] of Object.entries(file)) if (k.endsWith('_NEW') && v) env[k.slice(0, -4)] = v;
} else {
  for (const k of Object.keys(file)) if (k.endsWith('_NEW')) delete env[k];
}
console.error(`\x1b[33m! with-target: ${which} = ${ref}\x1b[0m`);
const r = spawnSync(cmd[0], cmd.slice(1), { stdio: 'inherit', env, shell: process.platform === 'win32' });
process.exit(r.status ?? 1);
