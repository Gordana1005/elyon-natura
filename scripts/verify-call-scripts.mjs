/**
 * verify-call-scripts — READ-ONLY health check of the targeted call scripts (owner 02.10.2026,
 * docs/CALL-SCRIPTS.md, migration 20260947000100).
 *
 *   node scripts/verify-call-scripts.mjs            (text report)
 *   node scripts/verify-call-scripts.mjs --json
 *   node scripts/verify-call-scripts.mjs --print-sql            (the facts query, for a dry-run)
 *   node scripts/verify-call-scripts.mjs --facts=<file.json>    (evaluate saved facts, no database)
 *
 * Exit: 0 = no FAIL · 1 = at least one FAIL · 2 = refused / not applied / DB unreachable.
 *
 *   V1  enums: every row's status / context_type / groups is a known value; the CHECK constraints exist
 *   V2  every product a script targets exists
 *   V3  every PUBLISHED targeted script has a title and a section with text
 *   V4  every row's version = its latest call_script_versions row, and that snapshot = the row
 *       (no write bypassed the writers); no orphan history except deletes
 *   V5  no write path for the browser: no INSERT / UPDATE / DELETE policy, no write grant to anon /
 *       authenticated on call_scripts / call_script_versions, the writers executable by service_role only,
 *       the append-only trigger in place
 *   V6  the one SELECT policy shows agents published rows only (InitPlan form); versions RLS on, no policy
 *   V7  app_settings.call_scripts is a guarded owner key with mode off | preview | on
 *   V8  every ACTIVE list name maps to a script group, or is one of the documented null pens
 *   V9  the legacy rows (product / order / prediction_lead) are still published and untargeted
 *   V10 Bulgarian content (евро / € / лв / Еконт / Спиди / Бугарија …) in mk / sq texts — WARN only
 *
 * Safety: the guard of scripts/verify-insights-ties.mjs (imported) — pinned to Macedonia
 * (oufoazmnbwugtfldkwsn), refused if .env points at Bulgaria, every statement a single SELECT /
 * WITH sent with read_only: true.
 */
import { readFileSync } from 'node:fs';

const ALL_GROUPS = ['lead_new', 'lead_callback', 'newcomers', 'd21', 'd57', 'm4_6', 'm6_12', 'y1_2', 'y2plus', 'cancels', 'never_converted', 'trash'];
// JS twin of groupOfListName (supabase/functions/api/callScriptMatch.ts; vitest checks the TS one
// against all 59 live names). Keep the two in step.
const PEN_GROUPS = {
  'Current Cancels': 'cancels', 'Cancelled Pendings': 'cancels',
  'Never-Converted Recent': 'never_converted', 'Never-Converted Old': 'never_converted',
  'Trash List': 'trash', 'Current Returns': null, 'Due to Reorder': null, 'FULL MONAD LIST': null,
};
const RECENCY_GROUPS = { NEWCOMERS: 'newcomers', '21d': 'd21', '57d': 'd57', '4-6m': 'm4_6', '6-12m': 'm6_12', '1-2yr': 'y1_2', '2yr+': 'y2plus' };
const NULL_PENS = Object.keys(PEN_GROUPS).filter((k) => PEN_GROUPS[k] === null);
function groupOfListName(name) {
  if (typeof name !== 'string') return undefined;
  const t = name.trim();
  if (Object.prototype.hasOwnProperty.call(PEN_GROUPS, t)) return PEN_GROUPS[t];
  const tok = t.split(/\s+/)[0] ?? '';
  return Object.prototype.hasOwnProperty.call(RECENCY_GROUPS, tok) ? RECENCY_GROUPS[tok] : undefined;
}

const CONSTRAINTS = [
  'call_scripts_status_check', 'call_scripts_context_type_check', 'call_scripts_groups_check', 'call_scripts_product_ids_check',
  'call_scripts_priority_check', 'call_scripts_sections_check', 'call_scripts_legacy_untargeted', 'call_scripts_version_check',
];
const WRITERS = [
  'public.call_script_save(uuid,uuid,integer,jsonb,text)', 'public.call_script_duplicate(uuid,uuid,jsonb,text)',
  'public.call_scripts_bulk(uuid,uuid[],jsonb,text)', 'public.call_script_restore(uuid,uuid,integer,text)',
  'public.call_script_delete(uuid,uuid,text)', 'public.call_scripts_set_mode(uuid,text,text)',
  'public.call_script_demand()', 'public.call_script_demand_json()',
];
const sqlList = (xs) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');
// Postgres twin of BG_CONTENT_RE (callScriptMatch.ts lintScript), case-insensitive.
const BG_RE = 'евро|€|(^|[^[:alpha:]])лв([^[:alpha:]]|$)|лева|Еконт|Спиди|Econt|Speedy|Бугарија|България';

const APPLIED_SQL = `
  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema = 'public' AND table_name = 'call_scripts' AND column_name = 'sections') AS columns,
         to_regclass('public.call_script_versions') IS NOT NULL AS versions,
         to_regprocedure('public.call_script_sections_text(jsonb,text)') IS NOT NULL AS text_fn`;

const FACTS_SQL = `
WITH c AS (SELECT * FROM public.call_scripts),
latest AS (
  SELECT DISTINCT ON (v.script_id) v.script_id, v.version, v.action, v.snapshot
    FROM public.call_script_versions v ORDER BY v.script_id, v.version DESC)
SELECT jsonb_build_object(
  'counts', (SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) FROM (SELECT context_type || '/' || status AS k, count(*) AS n FROM c GROUP BY 1) x),
  'bad_status', (SELECT count(*) FROM c WHERE status NOT IN ('draft', 'published', 'archived')),
  'bad_context', (SELECT count(*) FROM c WHERE context_type NOT IN ('order', 'prediction_lead', 'product', 'targeted')),
  'bad_groups', (SELECT count(*) FROM c WHERE NOT (groups <@ ARRAY[${sqlList(ALL_GROUPS)}]::text[])),
  'constraints', (SELECT coalesce(jsonb_agg(conname ORDER BY conname), '[]'::jsonb) FROM pg_constraint
                   WHERE conrelid = 'public.call_scripts'::regclass AND conname IN (${sqlList(CONSTRAINTS)})),
  'missing_products', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'product_id', p)), '[]'::jsonb)
                         FROM c, unnest(c.product_ids) p WHERE NOT EXISTS (SELECT 1 FROM public.products x WHERE x.id = p)),
  'targeted_products', (SELECT count(DISTINCT p) FROM c, unnest(c.product_ids) p),
  'published_no_text', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title)), '[]'::jsonb) FROM c
                          WHERE context_type = 'targeted' AND status = 'published'
                            AND (btrim(coalesce(title, '')) = '' OR public.call_script_sections_text(sections, 'mk') = '')),
  'version_mismatch', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title, 'version', c.version, 'latest', l.version)), '[]'::jsonb)
                         FROM c LEFT JOIN latest l ON l.script_id = c.id WHERE l.version IS DISTINCT FROM c.version),
  'snapshot_mismatch', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'title', c.title)), '[]'::jsonb)
                          FROM c JOIN latest l ON l.script_id = c.id AND l.version = c.version WHERE l.snapshot <> to_jsonb(c)),
  'orphan_history', (SELECT count(*) FROM latest l WHERE l.action <> 'delete' AND NOT EXISTS (SELECT 1 FROM c WHERE c.id = l.script_id)),
  'deleted', (SELECT count(*) FROM latest l WHERE l.action = 'delete' AND NOT EXISTS (SELECT 1 FROM c WHERE c.id = l.script_id)),
  'versions_total', (SELECT count(*) FROM public.call_script_versions),
  'write_policies', (SELECT coalesce(jsonb_agg(jsonb_build_object('table', polrelid::regclass::text, 'name', polname, 'cmd', polcmd)), '[]'::jsonb)
                       FROM pg_policy WHERE polrelid IN ('public.call_scripts'::regclass, 'public.call_script_versions'::regclass) AND polcmd <> 'r'),
  'select_policies', (SELECT coalesce(jsonb_agg(jsonb_build_object('name', polname, 'roles', polroles::regrole[]::text,
                                                                     'qual', pg_get_expr(polqual, polrelid))), '[]'::jsonb)
                        FROM pg_policy WHERE polrelid = 'public.call_scripts'::regclass AND polcmd = 'r'),
  'versions_policies', (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.call_script_versions'::regclass),
  'versions_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.call_script_versions'::regclass),
  'scripts_rls', (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.call_scripts'::regclass),
  'browser_grants', (SELECT coalesce(jsonb_agg(DISTINCT table_name || ':' || grantee || ':' || privilege_type), '[]'::jsonb)
                       FROM information_schema.role_table_grants
                      WHERE table_schema = 'public' AND grantee IN ('anon', 'authenticated', 'PUBLIC')
                        AND ((table_name = 'call_scripts' AND privilege_type IN ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'))
                          OR (table_name = 'call_script_versions'))),
  'writers', (SELECT coalesce(jsonb_agg(jsonb_build_object('fn', f.sig, 'exists', p.oid IS NOT NULL,
                        'browser_exec', CASE WHEN p.oid IS NULL THEN NULL
                                             ELSE has_function_privilege('authenticated', p.oid, 'EXECUTE') OR has_function_privilege('anon', p.oid, 'EXECUTE') END,
                        'service_exec', CASE WHEN p.oid IS NULL THEN NULL ELSE has_function_privilege('service_role', p.oid, 'EXECUTE') END)), '[]'::jsonb)
                FROM unnest(ARRAY[${sqlList(WRITERS)}]) AS f(sig) LEFT JOIN pg_proc p ON p.oid = to_regprocedure(f.sig)),
  'append_only_trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.call_script_versions'::regclass
                                    AND tgname = 'trg_call_script_versions_append_only' AND tgenabled <> 'D'),
  'setting', (SELECT value FROM public.app_settings WHERE key = 'call_scripts'),
  'guard_has_key', (SELECT position('''call_scripts''' IN prosrc) > 0 FROM pg_proc
                     WHERE oid = to_regprocedure('public.tg_app_settings_guard_owner_keys()')),
  'active_lists', (SELECT coalesce(jsonb_agg(name ORDER BY name), '[]'::jsonb) FROM public.prediction_segment_lists WHERE is_active),
  'legacy_bad', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'title', title, 'context_type', context_type, 'status', status)), '[]'::jsonb)
                   FROM c WHERE context_type <> 'targeted' AND (status <> 'published' OR groups <> '{}' OR product_ids <> '{}')),
  'legacy_copies', (SELECT count(*) FROM c t WHERE t.context_type = 'targeted'
                       AND EXISTS (SELECT 1 FROM c l WHERE l.id = t.copied_from AND l.context_type = 'product')),
  'legacy_products', (SELECT count(*) FROM c WHERE context_type = 'product'),
  'bg_rows', (SELECT coalesce(jsonb_agg(jsonb_build_object('title', title, 'context_type', context_type, 'status', status)
                                        ORDER BY context_type, title), '[]'::jsonb)
                FROM c WHERE status <> 'archived'
                  AND concat_ws(' ', title, description, script_text, translations::text, sections::text, helpers::text) ~* '${BG_RE}'),
  'mode', (SELECT value->>'mode' FROM public.app_settings WHERE key = 'call_scripts')
) AS facts`;

const n = (v) => Number(v ?? 0) || 0;
const results = [];
function check(id, title) {
  const c = { id, title, status: 'PASS', lines: [] };
  results.push(c);
  return {
    tie(label, want, got) {
      const ok = JSON.stringify(want) === JSON.stringify(got);
      c.lines.push({ label, want, got, ok });
      if (!ok) c.status = 'FAIL';
    },
    fail(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false }); c.status = 'FAIL'; },
    warn(label, detail) { c.lines.push({ label, want: null, got: detail, ok: false, warn: true }); if (c.status === 'PASS') c.status = 'WARN'; },
    info(label, detail) { c.lines.push({ label, want: null, got: detail, ok: true, info: true }); },
  };
}

export function evaluate(f) {
  // V1
  {
    const c = check('V1', 'enums: status, context_type, groups are known values; the CHECKs exist');
    c.tie('rows with an unknown status', 0, n(f.bad_status));
    c.tie('rows with an unknown context_type', 0, n(f.bad_context));
    c.tie('rows with an unknown group', 0, n(f.bad_groups));
    c.tie('CHECK constraints', [...CONSTRAINTS].sort(), [...(f.constraints || [])].sort());
    c.info('rows by context / status', f.counts);
  }
  // V2
  {
    const c = check('V2', 'every targeted product exists');
    c.tie('targets pointing at a missing product', [], f.missing_products || []);
    c.info('distinct products targeted', n(f.targeted_products));
  }
  // V3
  {
    const c = check('V3', 'every published targeted script has a title and text');
    c.tie('published without a title or a section with text', [], f.published_no_text || []);
  }
  // V4
  {
    const c = check('V4', 'version = the latest snapshot, and the snapshot = the row');
    c.tie('rows whose version is not their latest version row', [], f.version_mismatch || []);
    c.tie('rows that differ from their latest snapshot (a write bypassed the writers)', [], f.snapshot_mismatch || []);
    c.tie('history of a missing script whose last action is not a delete', 0, n(f.orphan_history));
    c.info('version rows', n(f.versions_total));
    c.info('deleted scripts (restorable by an admin)', n(f.deleted));
  }
  // V5
  {
    const c = check('V5', 'no write path for the browser');
    c.tie('INSERT / UPDATE / DELETE / ALL policies', [], f.write_policies || []);
    c.tie('anon / authenticated write grants (and any grant on versions)', [], f.browser_grants || []);
    const writers = f.writers || [];
    c.tie('writers missing', [], writers.filter((w) => !w.exists).map((w) => w.fn));
    c.tie('writers executable by anon / authenticated', [], writers.filter((w) => w.browser_exec).map((w) => w.fn));
    c.tie('writers not executable by service_role', [], writers.filter((w) => w.exists && !w.service_exec).map((w) => w.fn));
    c.tie('append-only trigger on call_script_versions', true, !!f.append_only_trigger);
  }
  // V6
  {
    const c = check('V6', 'the select policy shows agents published rows only');
    const pols = f.select_policies || [];
    c.tie('select policies on call_scripts', ['call_scripts_select'], pols.map((p) => p.name));
    const q = String(pols[0]?.qual ?? '');
    c.tie('policy filters published', true, /status\s*=\s*'published'/.test(q));
    c.tie('policy lets admins / managers see drafts', true, /is_admin_or_manager/.test(q));
    c.tie('policy needs internal staff', true, /is_internal_staff/.test(q));
    c.tie('policy uses the InitPlan form (SELECT auth.uid())', true, /SELECT auth\.uid\(\)/.test(q));
    c.tie('policy is for authenticated only', '{authenticated}', pols[0]?.roles ?? null);
    c.tie('RLS on call_scripts', true, !!f.scripts_rls);
    c.tie('RLS on call_script_versions', true, !!f.versions_rls);
    c.tie('policies on call_script_versions (deny-all)', 0, n(f.versions_policies));
  }
  // V7
  {
    const c = check('V7', 'app_settings.call_scripts is a guarded owner key');
    c.tie('setting present with a known mode', true, ['off', 'preview', 'on'].includes(f.mode));
    c.tie("tg_app_settings_guard_owner_keys guards 'call_scripts'", true, !!f.guard_has_key);
    c.info('mode', f.mode ?? null);
  }
  // V8
  {
    const c = check('V8', 'every active list maps to a group or a documented null pen');
    const lists = f.active_lists || [];
    const unknown = lists.filter((name) => groupOfListName(name) === undefined);
    c.tie('active lists with no group and not a documented pen', [], unknown);
    const nulls = lists.filter((name) => groupOfListName(name) === null);
    c.info('active lists', lists.length);
    c.info('null-group pens (only every-group scripts reach them)', nulls.length ? nulls.join(', ') : 'none');
    for (const name of nulls) if (!NULL_PENS.includes(name)) c.fail('undocumented null pen', name);
  }
  // V9
  {
    const c = check('V9', 'the legacy rows are still published and untargeted');
    c.tie('legacy rows not published / targeted', [], f.legacy_bad || []);
    c.info('legacy product rows', n(f.legacy_products));
    c.info('their targeted copies (drafts at migration)', n(f.legacy_copies));
  }
  // V10
  {
    const c = check('V10', 'Bulgarian content in the scripts (warning)');
    const rows = f.bg_rows || [];
    if (rows.length) c.warn(`${rows.length} rows mention евро / € / лв / Еконт / Спиди / Бугарија`, rows.map((r) => `${r.title} [${r.context_type}/${r.status}]`).join(' · '));
    else c.info('rows with Bulgarian content', 0);
  }
  return results;
}

function report(json) {
  const fail = results.some((c) => c.status === 'FAIL');
  if (json) {
    console.log(JSON.stringify({ tool: 'verify-call-scripts', read_only: true, generated_at: new Date().toISOString(), status: fail ? 'FAIL' : 'PASS', results }, null, 2));
  } else {
    console.log('verify-call-scripts · read-only · Macedonia');
    for (const c of results) {
      console.log(`\n${c.status.padEnd(4)}  ${c.id}  ${c.title}`);
      for (const l of c.lines) {
        if (l.info) console.log(`        · ${l.label}: ${typeof l.got === 'object' ? JSON.stringify(l.got) : l.got}`);
        else if (l.warn) console.log(`        ! ${l.label}: ${l.got}`);
        else if (!l.ok) console.log(`        ✗ ${l.label}: ${l.want == null ? JSON.stringify(l.got) : `want ${JSON.stringify(l.want)}, got ${JSON.stringify(l.got)}`}`);
      }
    }
    console.log(`\n${fail ? 'FAIL' : 'PASS'}`);
  }
  return fail ? 1 : 0;
}

async function main() {
  const json = process.argv.includes('--json');
  if (process.argv.includes('--print-sql')) { console.log(FACTS_SQL.trim()); return 0; }
  const factsFile = process.argv.find((a) => a.startsWith('--facts='))?.slice('--facts='.length);
  let facts;
  if (factsFile) {
    const raw = JSON.parse(readFileSync(factsFile, 'utf8'));
    facts = raw.facts ?? raw;
  } else {
    const { runSql } = await import('./verify-insights-ties.mjs');
    const [have] = await runSql(APPLIED_SQL);
    if (!have.columns || !have.versions || !have.text_fn) {
      console.error('verify-call-scripts: the targeted call scripts are not applied — apply supabase/migrations/20260947000100_call_scripts_targeting.sql first');
      return 2;
    }
    const [row] = await runSql(FACTS_SQL);
    facts = row.facts;
  }
  evaluate(facts);
  return report(json);
}

main().then((code) => process.exit(code)).catch((e) => { console.error(`verify-call-scripts error: ${e?.message ?? e}`); process.exit(2); });
