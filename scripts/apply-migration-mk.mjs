#!/usr/bin/env node
/**
 * Apply one or more migration files to the Macedonian project via the Supabase
 * Management API, then record them in supabase_migrations.schema_migrations.
 *
 * Why not `supabase db push`? It needs a direct Postgres connection, and the
 * database password for this project was never recorded (docs/VAULT.md §1 says
 * "Add it here once known"). The Management API runs SQL as the same `postgres`
 * role that db push uses, so the result is equivalent. Once the DB password is
 * recorded, prefer `npx supabase db push --linked`.
 *
 *   node scripts/apply-migration-mk.mjs 20260727000000_shipped_paid_at_recording.sql [...]
 *   node scripts/apply-migration-mk.mjs --dry-run <file>
 *
 * Guarantees:
 *   - refuses to run unless supabase/config.toml points at the MK ref
 *   - refuses to re-apply a version already in schema_migrations
 *   - stops at the FIRST failure (so a half-applied bundle never continues)
 *   - files are applied in the order given, one API call each, so files that
 *     must be alone in their own transaction (ALTER TYPE ... ADD VALUE) are
 *
 * Note: `statements` is recorded as the whole file in a single array element
 * rather than CLI-split statements. Only `version` is used for ordering and
 * repair, so this is faithful for every purpose that matters.
 */
import { readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// The target comes from scripts/lib/target.mjs (03.10.2026): config.toml, or ELYON_TARGET_REF during the move
// to the new project. Bulgaria and retired refs are refused there; the token follows the target.
import { TARGET, REF as EXPECTED_REF, FORBIDDEN_REFS, accessToken } from './lib/target.mjs';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const files = args.filter((a) => !a.startsWith('--'));
if (!files.length) { console.error('usage: apply-migration-mk.mjs [--dry-run] <file.sql> [...]'); process.exit(1); }

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

// Guard: never let this run against Bulgaria.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (FORBIDDEN_REFS.includes(ref)) fail(`config.toml project_id = "${ref}" is forbidden`);
if (ref !== EXPECTED_REF && !TARGET.overridden) fail(`config.toml project_id = "${ref}", expected "${EXPECTED_REF}"`);
if (TARGET.overridden) console.log(`· applying to the OVERRIDDEN target ${EXPECTED_REF} (config.toml = ${ref})`);

const token = accessToken();

async function sql(query) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${EXPECTED_REF}/database/query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${text}`);
  try { return JSON.parse(text); } catch { return text; }
}

const applied = new Set((await sql('select version from supabase_migrations.schema_migrations;')).map((r) => r.version));

for (const f of files) {
  const name = basename(f);
  const m = name.match(/^(\d{14})_(.+)\.sql$/);
  if (!m) fail(`filename is not a migration: ${name}`);
  const [, version, slug] = m;

  if (applied.has(version)) { console.log(`· ${version} ${slug} — already applied, skipping`); continue; }

  const body = readFileSync(join(root, 'supabase', 'migrations', name), 'utf8');

  // Last-chance poison check: nothing may ever point a MK cron at Bulgaria.
  if (body.includes('sxymaloycddnoxudxaqp')) fail(`${name} still contains the LIVE BULGARIAN project ref — rewrite it first`);

  if (dryRun) { console.log(`· ${version} ${slug} — would apply (${body.length} bytes)`); continue; }

  process.stdout.write(`→ ${version} ${slug} ... `);
  try {
    await sql(body);
  } catch (e) {
    console.log('\x1b[31mFAILED\x1b[0m');
    console.error(e.message);
    fail(`stopped at ${name}. Nothing after it was applied.`);
  }
  await sql(
    `insert into supabase_migrations.schema_migrations (version, name, statements)
     values ('${version}', ${quote(slug)}, array[${quote(body)}]);`,
  );
  console.log('\x1b[32mok\x1b[0m');
  applied.add(version);
}

function quote(s) { return `'${String(s).replace(/'/g, "''")}'`; }

const n = (await sql('select count(*)::int as n from supabase_migrations.schema_migrations;'))[0].n;
console.log(`\nschema_migrations now holds ${n} versions.`);
