#!/usr/bin/env node
/**
 * scripts/db-move/switch-repo.mjs — the repository side of the cutover (03.10.2026): make the NEW Supabase project
 * the one every script, the CLI and the build aim at.
 *
 *   node scripts/db-move/switch-repo.mjs --dry-run     # what would change
 *   node scripts/db-move/switch-repo.mjs --apply
 *
 * 1. supabase/config.toml  project_id → the new ref
 * 2. .env                  the six project keys: current → KEY_OLD, KEY_NEW → KEY (the _NEW lines removed)
 * 3. scripts/lib/target.mjs  RETIRED_REFS = [the old ref] — every script now refuses the old project
 * 4. index.html            the preconnect host
 * 5. the literal old ref → the new ref in scripts/ (not db-move, not lib/target.mjs), tools/, .grok/skills/,
 *    opencart-bridge/ and docs/ (not docs/handoff, VAULT.md, the security audit) — operational text and constants.
 * Never touched: supabase/ (historical migrations and the tests that read them; web-sync's FORBIDDEN_REFS already
 * names both), vercel.json (the CSP keeps both hosts for the transition), CLAUDE.md and MACEDONIA-STATUS.md (by hand).
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OLD = 'bmfxhgznttcnnlqloqzp', NEW = 'oufoazmnbwugtfldkwsn';
const APPLY = process.argv.includes('--apply');
const changed = [];
const write = (file, text) => { changed.push(relative(ROOT, file).split(sep).join('/')); if (APPLY) writeFileSync(file, text); };

// 1) config.toml
{
  const f = join(ROOT, 'supabase', 'config.toml'); const s = readFileSync(f, 'utf8');
  if (s.includes(`project_id = "${OLD}"`)) write(f, s.replace(`project_id = "${OLD}"`, `project_id = "${NEW}"`));
}
// 2) .env
{
  const f = join(ROOT, '.env'); const lines = readFileSync(f, 'utf8').split(/\r?\n/);
  const KEYS = ['VITE_SUPABASE_PROJECT_ID', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_ACCESS_TOKEN'];
  const get = (k) => { const l = lines.find((x) => x.startsWith(k + '=')); return l === undefined ? undefined : l.slice(k.length + 1); };
  const missing = KEYS.filter((k) => get(k + '_NEW') === undefined);
  if (missing.length && !KEYS.every((k) => get(k + '_OLD') !== undefined)) throw new Error(`.env lacks the _NEW keys: ${missing.join(', ')}`);
  if (!missing.length) {
    const out = [];
    for (const l of lines) {
      const k = KEYS.find((x) => l.startsWith(x + '='));
      const kn = KEYS.find((x) => l.startsWith(x + '_NEW='));
      if (k) { out.push(`${k}=${get(k + '_NEW')}`); out.push(`${k}_OLD=${l.slice(k.length + 1)}`); }
      else if (kn) { /* dropped: it is the main key now */ }
      else out.push(l);
    }
    write(f, out.join('\n'));
  }
}
// 3) target.mjs
{
  const f = join(ROOT, 'scripts', 'lib', 'target.mjs'); const s = readFileSync(f, 'utf8');
  const a = 'export const RETIRED_REFS = Object.freeze([]);';
  if (s.includes(a)) write(f, s.replace(a, 'export const RETIRED_REFS = Object.freeze([OLD_MK_REF]);   // retired at the cutover, 03.10.2026'));
}
// 4) index.html
{
  const f = join(ROOT, 'index.html'); const s = readFileSync(f, 'utf8');
  if (s.includes(`https://${OLD}.supabase.co`)) write(f, s.split(`https://${OLD}.supabase.co`).join(`https://${NEW}.supabase.co`));
}
// 5) literal ref in operational files
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'exports']);
const EXCLUDE = [/^scripts\/db-move\//, /^scripts\/lib\/target\.mjs$/, /^docs\/handoff\//, /^docs\/VAULT\.md$/, /^docs\/SECURITY-AUDIT/];
const TEXT = /\.(mjs|js|ts|py|sql|md|json|sh|twig|php|txt|toml|yml|yaml)$/i;
function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name); const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (TEXT.test(name) && st.size < 5_000_000) {
      const rel = relative(ROOT, p).split(sep).join('/');
      if (EXCLUDE.some((re) => re.test(rel))) continue;
      const s = readFileSync(p, 'utf8');
      if (s.includes(OLD)) write(p, s.split(OLD).join(NEW));
    }
  }
}
for (const d of ['scripts', 'tools', join('.grok', 'skills'), 'opencart-bridge', 'docs']) walk(join(ROOT, d));

console.log(`${APPLY ? 'changed' : 'would change'} ${changed.length} files:`);
const groups = {};
for (const c of changed) { const g = c.split('/').slice(0, c.startsWith('scripts/') ? 1 : 2).join('/'); (groups[g] ||= []).push(c); }
for (const [g, list] of Object.entries(groups)) console.log(`  ${g}: ${list.length}${list.length <= 6 ? ' — ' + list.join(', ') : ''}`);
