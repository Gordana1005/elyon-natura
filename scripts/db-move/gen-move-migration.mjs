#!/usr/bin/env node
/**
 * scripts/db-move/gen-move-migration.mjs — write supabase/migrations/20260948000100_project_move_function_urls.sql
 * from the LIVE definitions of the 7 cron callers exported by the inventory
 * (exports/db-move/<date>/invoke-functions-old.json: pg_get_functiondef + md5 of each body).
 *
 *   node scripts/db-move/gen-move-migration.mjs [YYYY-MM-DD]
 *
 * What the migration does (03.10.2026, the move to the new project):
 *   - public.project_functions_base_url() reads the vault secret `project_functions_base_url`
 *     (https://<ref>.supabase.co — the project's OWN host; later a custom domain) and returns NULL unless it is
 *     a bare https host;
 *   - the 7 invoke_* functions keep their exact bodies, but the hardcoded
 *     'https://bmfxhgznttcnnlqloqzp.supabase.co/functions/v1/…' becomes `_base || '/functions/v1/…'`, and they
 *     return (RAISE WARNING) when the base is NULL — fail closed, never a call to another project;
 *   - guards: the migration refuses to run unless the vault secret exists on THIS project, and unless the 7 live
 *     bodies still match the md5s recorded at generation time (no silent overwrite of a newer version).
 * The historical migrations are not touched (two tests read them by name).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const date = process.argv[2] || '2026-10-03';
const OLD_HOST = 'https://bmfxhgznttcnnlqloqzp.supabase.co';
const VERSION = '20260948000100';
const OUT = join(ROOT, 'supabase', 'migrations', `${VERSION}_project_move_function_urls.sql`);
const fns = JSON.parse(readFileSync(join(ROOT, 'exports', 'db-move', date, 'invoke-functions-old.json'), 'utf8'));
if (fns.length !== 7) throw new Error(`expected 7 functions, got ${fns.length}`);

const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
const parts = [];
parts.push(`-- ${VERSION}_project_move_function_urls.sql
-- Project move (03.10.2026): the cron callers no longer hardcode the project URL.
--
-- Until now 7 SQL functions (the pg_cron → edge-function callers) carried
-- '${OLD_HOST}/functions/v1/…' in their bodies. A restored copy of this database in ANOTHER
-- Supabase project would therefore drive the OLD project's functions from its cron — split-brain by default.
--
-- From here: one reader, public.project_functions_base_url(), returns the vault secret
-- \`project_functions_base_url\` (the project's OWN host, e.g. https://<ref>.supabase.co; later a custom domain) or
-- NULL. Every caller builds url := _base || '/functions/v1/<fn>' and RETURNS with a WARNING when the base is NULL:
-- fail closed, never a call to another project. The vault row is project-local by design (vault does not travel
-- with a dump) — a copy of this database calls nothing until an operator creates the row on it.
--
-- Guards: (1) refuses to run unless the vault secret exists and is a bare https host on THIS project;
-- (2) refuses if any of the 7 live bodies differs from the md5 recorded when this file was generated
-- (scripts/db-move/gen-move-migration.mjs from exports/db-move/${date}/invoke-functions-old.json).
-- Historical migrations stay untouched (supabase/functions/collabbox-sync/*.test.ts read them by name).
-- Generated — edit the generator, not this file.

SET LOCAL lock_timeout = '5s';

DO $guard$
DECLARE
  _u text;
BEGIN
  SELECT decrypted_secret INTO _u FROM vault.decrypted_secrets WHERE name = 'project_functions_base_url';
  IF _u IS NULL OR rtrim(_u, '/') !~ '^https://[a-z0-9.-]+$' THEN
    RAISE EXCEPTION 'project move: create the vault secret project_functions_base_url (https://<this project>.supabase.co) on THIS project first — this migration re-points every cron caller';
  END IF;
END
$guard$;

DO $drift$
DECLARE
  _expected jsonb := jsonb_build_object(
${fns.map((f) => `    ${q(f.proname)}, ${q(f.src_md5)}`).join(',\n')}
  );
  _r record;
BEGIN
  FOR _r IN
    SELECT p.proname, md5(replace(p.prosrc, chr(13), '')) AS live
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (${fns.map((f) => q(f.proname)).join(', ')})
  LOOP
    IF _expected ->> _r.proname IS DISTINCT FROM _r.live THEN
      RAISE EXCEPTION 'project move: public.%() changed since this migration was generated (live md5 %, expected %) — regenerate it',
        _r.proname, _r.live, _expected ->> _r.proname;
    END IF;
  END LOOP;
END
$drift$;

-- The one place the URL lives.
CREATE OR REPLACE FUNCTION public.project_functions_base_url()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  _u text;
BEGIN
  SELECT decrypted_secret INTO _u FROM vault.decrypted_secrets WHERE name = 'project_functions_base_url';
  _u := rtrim(_u, '/');
  IF _u IS NULL OR _u !~ '^https://[a-z0-9.-]+$' THEN
    RETURN NULL;
  END IF;
  RETURN _u;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END;
$fn$;
REVOKE ALL ON FUNCTION public.project_functions_base_url() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.project_functions_base_url() TO service_role;
COMMENT ON FUNCTION public.project_functions_base_url() IS
  'The base URL of THIS project''s edge functions (https://<ref>.supabase.co, from the vault secret project_functions_base_url), or NULL. Every pg_cron caller builds its URL from it — migration ${VERSION}.';
`);

for (const f of fns) {
  let def = f.def.replace(/\r\n/g, '\n');
  if (!def.includes(OLD_HOST)) throw new Error(`${f.proname}: no old host in body`);
  // 1) declare _base
  if (/\nDECLARE\n/.test(def)) def = def.replace(/\nDECLARE\n/, '\nDECLARE\n  _base text;\n');
  else def = def.replace(/\nBEGIN\n/, '\nDECLARE\n  _base text;\nBEGIN\n');
  // 2) resolve the base right before the call (after every existing gate), fail closed
  const call = def.indexOf('PERFORM net.http_post(');
  if (call < 0) throw new Error(`${f.proname}: no net.http_post`);
  const lineStart = def.lastIndexOf('\n', call) + 1;
  const indent = def.slice(lineStart, call);
  const gate = `${indent}_base := public.project_functions_base_url();\n${indent}IF _base IS NULL THEN\n${indent}  RAISE WARNING '${f.proname}: vault secret project_functions_base_url missing or invalid — no call made';\n${indent}  RETURN;\n${indent}END IF;\n`;
  def = def.slice(0, lineStart) + gate + def.slice(lineStart);
  // 3) the URL itself
  const before = (def.match(new RegExp(`url := '${OLD_HOST.replace(/[.]/g, '\\.')}(/functions/v1/[^']+)'`)) || [])[1];
  if (!before) throw new Error(`${f.proname}: url line not matched`);
  def = def.replace(`url := '${OLD_HOST}${before}'`, `url := _base || '${before}'`);
  if (def.includes(OLD_HOST)) {
    // comments that still name the old host are rewritten so the "no old ref in prosrc" check holds
    def = def.split(OLD_HOST).join('<this project>');
  }
  const comment = `${f.cmt ? f.cmt + ' ' : ''}Project move ${date}: the URL comes from public.project_functions_base_url() (vault secret project_functions_base_url) — migration ${VERSION}.`;
  parts.push(`\n-- ${f.proname}(${f.args}) — body as live on ${date} (md5 ${f.src_md5}), URL from the vault.\n${def.trim()};\nCOMMENT ON FUNCTION public.${f.proname}(${f.args}) IS ${q(comment)};\n`);
}

parts.push(`
-- Proof: no caller names the old host any more.
DO $check$
DECLARE _n int;
BEGIN
  SELECT count(*) INTO _n FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.prosrc LIKE '%${OLD_HOST.replace('https://', '')}%';
  IF _n > 0 THEN
    RAISE EXCEPTION 'project move: % function(s) still name the old host', _n;
  END IF;
END
$check$;
`);

writeFileSync(OUT, parts.join(''));
console.log(`wrote ${OUT} (${parts.join('').length} bytes, ${fns.length} functions)`);
