/**
 * scripts/lib/target.mjs — the ONE place a script learns which Supabase project it targets.
 *
 * Until 03.10.2026 every script carried its own `const REF = 'bmfxhgznttcnnlqloqzp'`. The move to the new
 * project `oufoazmnbwugtfldkwsn` (org elyongroup, Frankfurt) needs every script to aim at either project
 * for a while, so the ref is resolved here:
 *
 *   1. `ELYON_TARGET_REF` in the environment (must be one of KNOWN_MK_REFS, never Bulgaria, never a retired ref);
 *   2. otherwise `supabase/config.toml` `project_id` — exactly what every script did before.
 *
 * Tokens and keys follow the target: with the override set to the NEW ref, `.env` keys suffixed `_NEW`
 * (SUPABASE_ACCESS_TOKEN_NEW, SUPABASE_SERVICE_ROLE_KEY_NEW, VITE_SUPABASE_URL_NEW, …) win over the plain
 * ones, so `.env` can hold both projects during the move. `ELYON_DOTENV` names another dotenv file
 * (the convention scripts/lib/rls-initplan.mjs already had).
 *
 * Nothing here ever prints a token. The live Bulgarian ref is refused wherever it appears.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BG_REF = 'sxymaloycddnoxudxaqp';        // live Bulgaria — never a target, never touched
export const OLD_MK_REF = 'bmfxhgznttcnnlqloqzp';    // Macedonia until the cutover (org naturatherapykosovo, eu-west-1)
export const NEW_MK_REF = 'oufoazmnbwugtfldkwsn';    // Macedonia after the cutover (org elyongroup, eu-central-1)
/** Refs that were ours and are retired: add OLD_MK_REF in the cutover commit. */
export const RETIRED_REFS = Object.freeze([]);
export const KNOWN_MK_REFS = Object.freeze([NEW_MK_REF, OLD_MK_REF]);
export const FORBIDDEN_REFS = Object.freeze([BG_REF, ...RETIRED_REFS]);
export const ENV_OVERRIDE = 'ELYON_TARGET_REF';

export class TargetError extends Error {}

/** `project_id` of supabase/config.toml — what `supabase --linked` resolves to. */
export function configRef() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  if (toml.includes(BG_REF)) throw new TargetError('supabase/config.toml mentions the LIVE BULGARIAN project — refusing.');
  const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (!ref) throw new TargetError('supabase/config.toml has no project_id');
  return ref;
}

let banner = false;
/** The target: { ref, cfg, overridden }. Throws on Bulgaria, a retired ref or an unknown ref. */
export function resolveTarget() {
  const cfg = configRef();
  const override = (process.env[ENV_OVERRIDE] || '').trim();
  const ref = override || cfg;
  if (FORBIDDEN_REFS.includes(ref)) throw new TargetError(`target ${ref} is forbidden (Bulgaria or a retired project)`);
  if (!KNOWN_MK_REFS.includes(ref)) throw new TargetError(`target ${ref} is not a known Macedonian project`);
  const overridden = Boolean(override) && override !== cfg;
  if (overridden && !banner) {
    banner = true;
    console.error(`\x1b[33m! TARGET OVERRIDE ${ref} (supabase/config.toml = ${cfg})\x1b[0m`);
  }
  return { ref, cfg, overridden };
}

export const TARGET = resolveTarget();
export const REF = TARGET.ref;
export const MK_REF = REF;          // drop-in for scripts/lib/repair-kit.mjs
export const EXPECTED_REF = REF;    // drop-in for assert-mk-target / apply-migration-mk
export const PROJECT_URL = `https://${REF}.supabase.co`;
export const API_BASE = `https://api.supabase.com/v1/projects/${REF}`;
export const QUERY_URL = `${API_BASE}/database/query`;
export const IS_NEW = REF === NEW_MK_REF;

export function dotenvPath() {
  return process.env.ELYON_DOTENV || join(ROOT, '.env');
}

/** Parse a dotenv file (KEY=value, optional double quotes). Missing file → {}. Refuses any Bulgarian mention. */
export function readDotenv(file = dotenvPath()) {
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return {}; }
  if (text.includes(BG_REF)) throw new TargetError(`${file} mentions the LIVE BULGARIAN project — refusing.`);
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/**
 * The environment of the TARGET, as a plain object: dotenv + process.env, where for the NEW project every
 * `KEY_NEW` replaces `KEY`. Only the keys that name a project are remapped; everything else passes through.
 */
export function targetEnv() {
  const file = readDotenv();
  const merged = { ...file, ...process.env };
  if (!IS_NEW) return merged;
  const out = { ...merged };
  for (const [k, v] of Object.entries(merged)) {
    if (k.endsWith('_NEW') && v) out[k.slice(0, -4)] = v;
  }
  return out;
}

/** The Management API token for the target. Never printed. */
export function accessToken() {
  const env = targetEnv();
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new TargetError(`SUPABASE_ACCESS_TOKEN${IS_NEW ? '_NEW' : ''} missing (set it in ${dotenvPath()})`);
  return token;
}

/** The project-naming keys must agree with the target and may never name a forbidden project. */
export function assertEnvAgrees() {
  const env = targetEnv();
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID']) {
    const v = env[k];
    if (!v) continue;
    for (const f of FORBIDDEN_REFS) if (v.includes(f)) throw new TargetError(`${k} points at a forbidden project (${f}) — refusing.`);
    if (!v.includes(REF)) throw new TargetError(`${k} does not point at ${REF} — refusing. (${IS_NEW ? 'set the _NEW keys in .env' : 'check .env'})`);
  }
}

/** One Management API SQL call against the target. `readOnly` runs as supabase_read_only_user. */
export async function managementSql(query, { readOnly = false } = {}) {
  const res = await fetch(QUERY_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(readOnly ? { query, read_only: true } : { query }),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Management API ${res.status}: ${text.slice(0, 2000)}`);
    err.status = res.status;
    throw err;
  }
  if (!text) return [];
  const json = JSON.parse(text);
  return Array.isArray(json) ? json : [];
}
