/**
 * verify-personal-notes — READ-ONLY proof that the Личен дневник (personal notebooks and notes,
 * plan "Фаза 6", migration 20260944000400) holds its promises on the live data.
 *
 *   node scripts/verify-personal-notes.mjs            (text report)
 *   node scripts/verify-personal-notes.mjs --json
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   N1  deny-all: neither anon nor authenticated holds ANY privilege on personal_notebooks /
 *       personal_notes, RLS is on, there is not one policy; the purge is callable by nobody but
 *       its owner, the two read helpers by service_role only
 *   N2  a note always sits in a notebook of its own owner (the composite FK) — no orphan, no
 *       note whose owner differs from its notebook's owner
 *   N3  the purge cron 'personal-notes-purge' is scheduled ('40 1 * * *', active) and calls
 *       public.personal_notes_purge()
 *   N4  nothing soft-deleted more than 31 days ago (30 days + the nightly run) is left
 *   ·   counts: live notebooks / notes, authors, soft-deleted waiting
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported, not copied) — pinned to
 * Macedonia (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single
 * SELECT / WITH sent with read_only: true. Never reads a title or a body — only counts.
 */
import { runSql } from './verify-insights-ties.mjs';

const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v ?? 0) || 0);
const TABLES = ['personal_notebooks', 'personal_notes'];

const results = [];
const timings = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}
async function timed(label, sql) {
  const t0 = Date.now();
  const rows = await runSql(sql);
  timings.push({ label, ms: Date.now() - t0 });
  return rows;
}

// ── N1: deny-all ──────────────────────────────────────────────────────────────
async function verifyDenyAll() {
  const c = check('N1', 'deny-all: no privilege for anon / authenticated, RLS on, no policy; functions locked');
  const privs = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
  for (const t of TABLES) {
    const cols = ['anon', 'authenticated'].flatMap((r) =>
      privs.map((p) => `has_table_privilege('${r}', 'public.${t}', '${p}') AS "${r}_${p.toLowerCase()}"`));
    const [row] = await timed(`privileges ${t}`, `
      SELECT ${cols.join(',\n             ')},
             (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass) AS rls,
             (SELECT count(*)::int FROM pg_policies WHERE schemaname = 'public' AND tablename = '${t}') AS policies,
             has_table_privilege('service_role', 'public.${t}', 'SELECT') AS service_role_select`);
    const granted = Object.entries(row).filter(([k, v]) => /^(anon|authenticated)_/.test(k) && v === true).map(([k]) => k);
    c.tie(`${t}: privileges held by anon / authenticated`, [], granted);
    c.tie(`${t}: SELECT for authenticated`, false, row.authenticated_select);
    c.tie(`${t}: RLS enabled`, true, row.rls);
    c.tie(`${t}: policies`, 0, n(row.policies));
    c.tie(`${t}: service_role can read (the api)`, true, row.service_role_select);
  }
  const [fn] = await timed('function privileges', `
    SELECT has_function_privilege('anon', 'public.personal_notes_purge()', 'EXECUTE') AS purge_anon,
           has_function_privilege('authenticated', 'public.personal_notes_purge()', 'EXECUTE') AS purge_authenticated,
           has_function_privilege('service_role', 'public.personal_notes_purge()', 'EXECUTE') AS purge_service_role,
           has_function_privilege('authenticated', 'public.personal_notebooks_overview(uuid)', 'EXECUTE') AS overview_authenticated,
           has_function_privilege('anon', 'public.personal_notebooks_overview(uuid)', 'EXECUTE') AS overview_anon,
           has_function_privilege('authenticated', 'public.personal_notes_authors()', 'EXECUTE') AS authors_authenticated,
           has_function_privilege('anon', 'public.personal_notes_authors()', 'EXECUTE') AS authors_anon,
           has_function_privilege('service_role', 'public.personal_notes_authors()', 'EXECUTE') AS authors_service_role`);
  c.tie('purge executable by anon / authenticated / service_role', [false, false, false],
    [fn.purge_anon, fn.purge_authenticated, fn.purge_service_role]);
  c.tie('read helpers executable by anon / authenticated', [false, false, false, false],
    [fn.overview_anon, fn.overview_authenticated, fn.authors_anon, fn.authors_authenticated]);
  c.tie('authors helper executable by service_role (the api)', true, fn.authors_service_role);
}

// ── N2: a note lives in its owner's notebook ─────────────────────────────────
async function verifyOwnership() {
  const c = check('N2', "every note sits in a notebook of its own owner — no orphan, no foreign notebook");
  const [row] = await timed('ownership', `
    SELECT count(*) FILTER (WHERE b.id IS NULL)::int AS orphans,
           count(*) FILTER (WHERE b.id IS NOT NULL AND b.owner_id <> n.owner_id)::int AS foreign_owner,
           count(*)::int AS notes
      FROM public.personal_notes n
      LEFT JOIN public.personal_notebooks b ON b.id = n.notebook_id`);
  c.tie('notes without a notebook', 0, n(row.orphans));
  c.tie("notes whose owner differs from the notebook's", 0, n(row.foreign_owner));
  c.info('notes checked (live + deleted)', n(row.notes));
}

// ── N3: the purge cron ───────────────────────────────────────────────────────
async function verifyCron() {
  const c = check('N3', "the purge cron 'personal-notes-purge' is scheduled and calls personal_notes_purge()");
  const rows = await timed('cron', `
    SELECT schedule, active, position('personal_notes_purge()' in command) > 0 AS calls_purge
      FROM cron.job WHERE jobname = 'personal-notes-purge'`);
  c.tie('jobs named personal-notes-purge', 1, rows.length);
  if (rows.length) {
    c.tie('schedule (GMT; = 03:40 Skopje in summer)', '40 1 * * *', rows[0].schedule);
    c.tie('active', true, rows[0].active);
    c.tie('command calls public.personal_notes_purge()', true, rows[0].calls_purge);
  }
  const last = await timed('cron last run', `
    SELECT d.status, d.start_time::text AS start_time
      FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
     WHERE j.jobname = 'personal-notes-purge'
     ORDER BY d.start_time DESC LIMIT 1`);
  c.info('last run', last.length ? `${last[0].status} at ${last[0].start_time}` : 'not run yet (first run tonight 01:40 GMT)');
}

// ── N4: nothing past the window ──────────────────────────────────────────────
async function verifyPurgeWindow() {
  const c = check('N4', 'nothing soft-deleted more than 31 days ago is left');
  const [row] = await timed('purge window', `
    SELECT (SELECT count(*)::int FROM public.personal_notebooks WHERE deleted_at < now() - interval '31 days') AS old_notebooks,
           (SELECT count(*)::int FROM public.personal_notes WHERE deleted_at < now() - interval '31 days') AS old_notes,
           (SELECT count(*)::int FROM public.personal_notebooks WHERE deleted_at IS NOT NULL) AS deleted_notebooks,
           (SELECT count(*)::int FROM public.personal_notes WHERE deleted_at IS NOT NULL) AS deleted_notes,
           (SELECT count(*)::int FROM public.personal_notebooks WHERE deleted_at IS NULL) AS live_notebooks,
           (SELECT count(*)::int FROM public.personal_notes WHERE deleted_at IS NULL) AS live_notes,
           (SELECT count(DISTINCT owner_id)::int FROM public.personal_notebooks WHERE deleted_at IS NULL) AS authors`);
  c.tie('notebooks deleted > 31 days ago', 0, n(row.old_notebooks));
  c.tie('notes deleted > 31 days ago', 0, n(row.old_notes));
  c.info('live', `${n(row.live_notebooks)} notebooks · ${n(row.live_notes)} notes · ${n(row.authors)} authors`);
  c.info('soft-deleted, restorable', `${n(row.deleted_notebooks)} notebooks · ${n(row.deleted_notes)} notes`);
}

async function main() {
  const json = process.argv.includes('--json');
  const [have] = await runSql(`
    SELECT to_regclass('public.personal_notebooks') IS NOT NULL AS notebooks,
           to_regclass('public.personal_notes') IS NOT NULL AS notes,
           to_regprocedure('public.personal_notes_purge()') IS NOT NULL AS purge`);
  const missing = ['notebooks', 'notes', 'purge'].filter((k) => !have[k]);
  if (missing.length) {
    console.error(`verify-personal-notes: not applied yet (${missing.join(', ')}) — apply 20260944000400 first`);
    process.exit(2);
  }
  await verifyDenyAll();
  await verifyOwnership();
  await verifyCron();
  await verifyPurgeWindow();

  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-personal-notes', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results, timings }, null, 2));
  } else {
    console.log('verify-personal-notes · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`);
        else console.log(`        ✓ ${l.label}`);
      }
    }
    console.log(`\ntimings: ${timings.map((t) => `${t.label} ${t.ms} ms`).join(' · ')}`);
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(`verify-personal-notes error: ${e?.message ?? e}`); process.exit(2); });
