#!/usr/bin/env node
/**
 * Syntax-check the Supabase edge functions before deploying them.
 *
 *   node scripts/parse-edge-fn.mjs                    # all functions
 *   node scripts/parse-edge-fn.mjs api                # just supabase/functions/api
 *
 * Why this exists: `supabase/functions/**` is Deno and is NOT covered by
 * tsconfig.app.json, so `npm run build` and `tsc` never look at it. A syntax
 * error there is only discovered when the deploy fails — or worse, when the
 * function 500s in production. This is the only compile-time gate those files
 * have, and it is step 4 of the verification ritual in
 * docs/LEADS_PORT_GUIDE_MK.md.
 *
 * NOTE: this checks SYNTAX only. esbuild strips types without checking them, so
 * a type error still gets through. It catches the class of mistake that actually
 * happens when hand-editing a 16k-line handler: an unbalanced brace.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const esbuild = createRequire(join(root, 'package.json'))('esbuild');

const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const fnRoot = join(root, 'supabase', 'functions');

const targets = [];
for (const entry of readdirSync(fnRoot)) {
  if (entry.startsWith('_')) continue;                       // _shared etc.
  if (only.length && !only.includes(entry)) continue;
  const dir = join(fnRoot, entry);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (f.endsWith('.ts')) targets.push(join(dir, f));
  }
}

if (!targets.length) {
  console.error(`no .ts files found under ${fnRoot}${only.length ? ` for ${only.join(', ')}` : ''}`);
  process.exit(1);
}

let failed = 0;
for (const file of targets) {
  const src = readFileSync(file, 'utf8');
  const rel = file.slice(root.length + 1).replace(/\\/g, '/');
  try {
    esbuild.transformSync(src, { loader: 'ts' });
    console.log(`\x1b[32m✓\x1b[0m ${rel} — ${src.split('\n').length} lines`);
  } catch (e) {
    failed++;
    console.error(`\x1b[31m✗ ${rel}\x1b[0m`);
    for (const err of e.errors ?? []) {
      const loc = err.location;
      console.error(`  ${loc ? `line ${loc.line}:${loc.column} — ` : ''}${err.text}`);
      if (loc?.lineText) console.error(`    ${loc.lineText.trim()}`);
    }
    if (!e.errors?.length) console.error(`  ${e.message}`);
  }
}

console.log(
  failed
    ? `\n\x1b[31m${failed} of ${targets.length} file(s) failed to parse.\x1b[0m`
    : `\n\x1b[32mAll ${targets.length} edge function file(s) parse cleanly.\x1b[0m`,
);
process.exit(failed ? 1 : 0);
