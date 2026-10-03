#!/usr/bin/env node
/**
 * scripts/db-move/collect-secrets.mjs — assemble the 15 edge-function secrets of the Macedonian CRM for the
 * NEW project from docs/VAULT.md, and PROVE each value against the SOURCE project without printing anything:
 * the Management API returns only a SHA-256 digest per secret, so sha256(value) must equal the digest.
 *
 *   node scripts/db-move/collect-secrets.mjs [YYYY-MM-DD]
 *
 * The four `*_SYNC_SECRET` values are OUR shared secrets (vault row ↔ function header): they are matched by
 * digest among every 64-hex token in the vault, and a value the vault does not hold is GENERATED fresh for the
 * new project (both sides are set from the same file, so the pair stays consistent) — reported as "generated".
 *
 * Output: exports/db-move/<date>/secrets.env (gitignored) — KEY=value lines — consumed by deploy-functions.mjs
 * (function secrets) and restore-new.mjs (the 4 vault rows). Printed: name → status only.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE_REF = 'bmfxhgznttcnnlqloqzp';
const date = process.argv[2] || '2026-10-03';
const OUT = join(ROOT, 'exports', 'db-move', date, 'secrets.env');
const vault = readFileSync(join(ROOT, 'docs', 'VAULT.md'), 'utf8').replace(/\r\n/g, '\n');
const env = {};
for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
  if (m) env[m[1]] = m[2];
}
const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

const r = await fetch(`https://api.supabase.com/v1/projects/${SOURCE_REF}/secrets`, { headers: { Authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` } });
if (!r.ok) throw new Error(`secrets digest list → ${r.status}`);
const digests = Object.fromEntries((await r.json()).map((s) => [s.name, s.value]));

/** First backtick-quoted token (≥ minLen chars, no spaces) within `window` lines after the first mention of `label`. */
function after(label, { minLen = 16, window = 8 } = {}) {
  const lines = vault.split('\n');
  const i = lines.findIndex((l) => l.includes(label));
  if (i < 0) return null;
  const chunk = lines.slice(i, i + window).join('\n');
  const all = [...chunk.matchAll(/`([^`\s]+)`/g)].map((m) => m[1]).filter((v) => v.length >= minLen && v !== label.replace(/`/g, ''));
  return all[0] ?? null;
}
/** Among every candidate token in the vault, the one whose sha256 equals the source digest. */
function byDigest(name, candidates) {
  const d = digests[name];
  if (!d) return null;
  return candidates.find((v) => sha(v) === d) ?? null;
}
const hex64 = [...new Set([...vault.matchAll(/\b([0-9a-f]{64})\b/g)].map((m) => m[1]))];
const anyToken = [...new Set([...vault.matchAll(/`([^`\s]{8,})`/g)].map((m) => m[1]))];

const values = {
  WEBHOOK_SECRET: byDigest('WEBHOOK_SECRET', hex64) ?? after('`WEBHOOK_SECRET`'),
  ALTERCPA_SYNC_SECRET: byDigest('ALTERCPA_SYNC_SECRET', hex64),
  ALTERCPA_TOKEN_MAIN: byDigest('ALTERCPA_TOKEN_MAIN', [...anyToken, env.ALTERCPA_API_KEY].filter(Boolean)),
  ALTERCPA_PUSH_TOKEN_DRAGANA: byDigest('ALTERCPA_PUSH_TOKEN_DRAGANA', anyToken),
  MEX_API_KEY: byDigest('MEX_API_KEY', anyToken),
  MEX_SYNC_SECRET: byDigest('MEX_SYNC_SECRET', hex64),
  MEX_API_KEY_2: byDigest('MEX_API_KEY_2', anyToken),
  COLLABBOX_USER: byDigest('COLLABBOX_USER', anyToken) ?? ((vault.match(/\*\*User:\*\* `([^`]+)`/) || [])[1] || null),
  COLLABBOX_PASS: byDigest('COLLABBOX_PASS', anyToken) ?? ((vault.match(/\*\*Password:\*\* `([^`]+)`/) || [])[1] || null),
  COLLABBOX_SYNC_SECRET: byDigest('COLLABBOX_SYNC_SECRET', hex64),
  WEB_SHOP_DB_URL: byDigest('WEB_SHOP_DB_URL', anyToken),
  WEB_SYNC_SECRET: byDigest('WEB_SYNC_SECRET', hex64),
  INSIGHTS_ENGINE: 'sql',
  AGENT_PERF_ENGINE: 'sql',
  PAYOUT_SUMMARY_ENGINE: 'sql',
};

let bad = 0;
const lines = [];
const generated = [];
for (const [name, v0] of Object.entries(values)) {
  let v = v0;
  let status;
  if (!v && /_SYNC_SECRET$/.test(name)) { v = randomBytes(32).toString('hex'); generated.push(name); status = 'generated (new pair for the new project)'; }
  else if (!v) { console.log(`  ${name.padEnd(28)} MISSING`); bad++; continue; }
  else status = digests[name] ? (sha(v) === digests[name] ? 'ok (sha256 = source digest)' : `MISMATCH`) : 'not on source (will still be set)';
  if (status === 'MISMATCH') bad++;
  console.log(`  ${name.padEnd(28)} ${status}`);
  lines.push(`${name}=${v}`);
}
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`${lines.length} secrets written to ${OUT}; generated: ${generated.join(', ') || 'none'}; problems: ${bad}`);
process.exit(bad ? 1 : 0);
