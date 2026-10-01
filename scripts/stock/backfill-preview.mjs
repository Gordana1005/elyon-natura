/**
 * backfill-preview — what stock v2 computes from the opening (22.09.2026 00:00 Skopje) to today, per day
 * and article, WITHOUT writing anything. For the owner's review before the switch is turned on.
 *
 *   node scripts/stock/backfill-preview.mjs
 *        [--from=2026-09-22] [--to=<today>]
 *        [--opening=exports/stock/openings.json --variant=04_morning_2209]
 *        [--out=exports/stock/preview] [--ledger]
 *
 *   default      the engine is installed (20260945000100…0500): read-only queries on stock_v2_day /
 *                stock_v2_parcels_day / stock_v2_parcels in PREVIEW (stock_v2_desired(); --ledger reads
 *                stock_moves instead). One SELECT, read_only: true.
 *   --unapplied  the engine is NOT installed yet: the five migration files run inside ONE transaction that
 *                always ends in a raised exception (= rollback; the result travels in its message) — the
 *                same dry-run technique the workstreams use. Runs scripts/assert-mk-target.mjs first. With
 *                it, optionally load what the database does not have yet (all inside the rolled-back
 *                transaction, nothing persists):
 *                  --articles=exports/stock/articles.json   stock_articles_upsert
 *                  --kits=exports/stock/kits.json           stock_article_kits_upsert
 *                  --recipes=exports/stock/recipes.json     product_articles_set(approve) — "as if approved"
 *                  --seed-collabbox                         an APPROXIMATION when the files are not there:
 *                        articles = the 6-digit codes on collabBox goods lines since 01.05.2026, recipes =
 *                        a CRM product → the code it carries on ≥ 80 % (and ≥ 3) of its collabBox lines
 *   --opening / --variant   adds that variant's lines (openings.json, docs/STOCK-V2.md "Data files") to every
 *                day client-side — the counted shelf at 22.09 00:00 — so opening / closing are real numbers.
 *                Without it everything accumulates from 0 and the file says opening: null.
 *
 * Output (exports/ is gitignored — business-confidential): <out>/stock-preview-<from>_<to>[-<variant>].json
 * and .xlsx with the sheets Summary · Days×Articles · Parcels by day · Unresolved parcels · Negatives · About.
 * No receiver name or phone is read or written; no money.
 *
 * Exit: 0 = written · 2 = refused / not installed / DB unreachable.
 *
 * Safety: pinned to Macedonia (bmfxhgznttcnnlqloqzp); refused if config.toml / .env point elsewhere or at
 * Bulgaria. The default mode is read-only by construction (verify-insights-ties.mjs guard). --unapplied never
 * commits: the statement it sends ends in RAISE EXCEPTION inside its own BEGIN.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSql } from '../verify-insights-ties.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const REF = 'bmfxhgznttcnnlqloqzp';
const FORBIDDEN_REF = 'sxymaloycddnoxudxaqp';
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const MIGRATIONS = ['20260945000100_stock_v2_schema.sql', '20260945000200_stock_v2_resolver.sql',
  '20260945000300_stock_v2_apply.sql', '20260945000400_stock_v2_writers.sql', '20260945000500_stock_v2_reports.sql'];

class Refusal extends Error {}
const arg = (name) => process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name) => process.argv.includes(`--${name}`);
const n = (v) => Number(v ?? 0) || 0;
const r3 = (v) => Math.round(v * 1000) / 1000;
const abs = (p) => (isAbsolute(p) ? p : join(ROOT, p));

function skopjeToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

/** The one statement: every day sheet, every parcel day, the unresolved parcels. */
function previewQuery(from, to, preview) {
  return `SELECT jsonb_build_object(
  'days', (SELECT jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'),
                                               'sheet', public.stock_v2_day(d::date, 'main', NULL, false, ${preview})) ORDER BY d)
             FROM generate_series('${from}'::date, '${to}'::date, interval '1 day') d),
  'parcels', (SELECT jsonb_agg(jsonb_build_object('day', to_char(d, 'YYYY-MM-DD'),
                                                  'p', public.stock_v2_parcels_day(d::date, '{}'::jsonb, 0, 0, false) - 'rows') ORDER BY d)
                FROM generate_series('${from}'::date, '${to}'::date, interval '1 day') d),
  'unresolved', (SELECT coalesce(jsonb_agg(jsonb_build_object(
                    'tracking_id', p.tracking_id, 'account', p.account, 'series', p.series, 'status_id', p.status_id,
                    'created_day', to_char(p.created_at_mex AT TIME ZONE 'Europe/Skopje', 'YYYY-MM-DD'),
                    'state', p.state, 'lines_source', p.lines_source, 'flags', p.flags, 'units', p.units,
                    'unmapped', p.unmapped) ORDER BY p.created_at_mex, p.tracking_id), '[]'::jsonb)
                   FROM public.stock_v2_parcels(NULL, NULL) p
                  WHERE p.state IN ('unmapped', 'partial', 'no_lines', 'waiting_lines', 'no_route')
                     OR p.flags && ARRAY['possible_relabel', 'stale_label', 'return_no_route']::text[]),
  'states', (SELECT jsonb_object_agg(s.state, s.n) FROM (SELECT p.state, count(*) AS n FROM public.stock_v2_parcels(NULL, NULL) p GROUP BY 1) s),
  'articles_loaded', (SELECT count(*) FROM public.stock_articles),
  'recipes_approved', (SELECT count(DISTINCT pa.product_id) FROM public.product_articles pa WHERE pa.status = 'approved')) AS j`;
}

// ── --unapplied: the rolled-back transaction ───────────────────────────────────
function loadToken() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  if (toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1] !== REF) throw new Refusal('supabase/config.toml is not Macedonia');
  const env = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) env[m[1]] = m[2];
  }
  for (const k of ['SUPABASE_URL', 'VITE_SUPABASE_URL', 'VITE_SUPABASE_PROJECT_ID'])
    if (env[k]?.includes(FORBIDDEN_REF)) throw new Refusal(`.env ${k} points at LIVE BULGARIA`);
  if (!env.SUPABASE_ACCESS_TOKEN) throw new Refusal('SUPABASE_ACCESS_TOKEN not found in .env');
  return env.SUPABASE_ACCESS_TOKEN;
}

const strip = (s) => s.replace(/\r/g, '').split('\n')
  .filter((l) => !/^\s*(BEGIN|COMMIT)\s*;\s*$/i.test(l) && !/^\s*NOTIFY\s+pgrst/i.test(l)).join('\n');

function jsonLiteral(value) {
  const s = JSON.stringify(value);
  if (s.includes('$sv2json$')) throw new Refusal('input file contains the quoting tag');
  return `$sv2json$${s}$sv2json$::jsonb`;
}

const SEED_COLLABBOX = `
DO $seed$
DECLARE a uuid := (SELECT u.id FROM auth.users u ORDER BY u.created_at LIMIT 1);
BEGIN
  PERFORM public.stock_articles_upsert((
    SELECT jsonb_agg(jsonb_build_object('code', x.code, 'name', x.name, 'unit', 'КОМ'))
    FROM (SELECT e->>'code' AS code, mode() WITHIN GROUP (ORDER BY e->>'name') AS name
            FROM public.collabbox_documents d CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') e
           WHERE d.doc_at >= '2026-05-01' AND e->>'role' = 'goods' AND (e->>'code') ~ '^[0-9]{6}$'
           GROUP BY 1) x), 'sigma', a, false);
  PERFORM public.product_articles_set(y.pid, jsonb_build_array(jsonb_build_object('code', y.code, 'qty', 1, 'role', 'main')),
                                      NULL, 'preview_seed_collabbox', 'medium', true, 'backfill-preview approximation', a)
  FROM (SELECT (e->>'product_id')::uuid AS pid, e->>'code' AS code, count(*) AS n,
               sum(count(*)) OVER (PARTITION BY (e->>'product_id')::uuid) AS tot,
               row_number() OVER (PARTITION BY (e->>'product_id')::uuid ORDER BY count(*) DESC) AS rn
          FROM public.collabbox_documents d CROSS JOIN LATERAL jsonb_array_elements(d.payload->'lines') e
         WHERE d.doc_at >= '2026-05-01' AND e->>'role' = 'goods' AND (e->>'code') ~ '^[0-9]{6}$'
           AND (e->>'product_id') ~* '^[0-9a-f-]{36}$'
         GROUP BY 1, 2) y
  WHERE y.rn = 1 AND y.n >= 3 AND y.n >= 0.8 * y.tot AND EXISTS (SELECT 1 FROM public.products p WHERE p.id = y.pid);
END
$seed$;`;

function seedFromFiles() {
  const parts = [];
  const actor = `(SELECT u.id FROM auth.users u ORDER BY u.created_at LIMIT 1)`;
  if (arg('articles')) {
    const rows = JSON.parse(readFileSync(abs(arg('articles')), 'utf8'));
    parts.push(`SELECT public.stock_articles_upsert(${jsonLiteral(rows)}, 'sigma', ${actor}, false);`);
  }
  if (arg('kits')) {
    const rows = JSON.parse(readFileSync(abs(arg('kits')), 'utf8'));
    parts.push(`SELECT public.stock_article_kits_upsert(${jsonLiteral(rows)}, ${actor});`);
  }
  if (arg('recipes')) {
    const rows = JSON.parse(readFileSync(abs(arg('recipes')), 'utf8'))
      .filter((r) => /^[0-9a-f-]{36}$/i.test(r.product_id ?? '') && Array.isArray(r.lines) && r.lines.length);
    parts.push(`SELECT public.product_articles_set((r->>'product_id')::uuid, r->'lines', NULL, coalesce(r->>'source', 'recipes.json'),
                        CASE WHEN r->>'confidence' IN ('high', 'medium', 'low') THEN r->>'confidence' END, true,
                        'backfill-preview: as if approved', ${actor})
                FROM jsonb_array_elements(${jsonLiteral(rows)}) r;`);
  }
  return parts.join('\n');
}

async function unappliedResult(query) {
  const trip = spawnSync(process.execPath, [join(ROOT, 'scripts', 'assert-mk-target.mjs')], { encoding: 'utf8' });
  if (trip.status !== 0) throw new Refusal(`tripwire refused:\n${trip.stdout ?? ''}${trip.stderr ?? ''}`);
  const token = loadToken();
  const files = MIGRATIONS.map((f) => strip(readFileSync(join(ROOT, 'supabase', 'migrations', f), 'utf8'))).join('\n\n');
  const seeds = (flag('seed-collabbox') ? SEED_COLLABBOX : '') + '\n' + seedFromFiles();
  const body = `BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '240s';
ALTER TABLE public.mex_parcels ADD COLUMN IF NOT EXISTS picked_up_at timestamptz, ADD COLUMN IF NOT EXISTS picked_up_basis text;
${files}
;
${seeds}
DO $preview$ DECLARE v text; BEGIN v := (${query})::text; RAISE EXCEPTION 'PREVIEW_RESULT:%', v; END $preview$;
`;
  if (body.includes(FORBIDDEN_REF)) throw new Refusal('Bulgarian ref in SQL — refusing');
  const res = await fetch(API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: body }),
    signal: AbortSignal.timeout(300_000),
  });
  const text = await res.text();
  let msg = text; try { msg = JSON.parse(text).message ?? text; } catch { /* keep text */ }
  const i = msg.indexOf('PREVIEW_RESULT:');
  if (i < 0) throw new Error(`preview transaction failed (rolled back): ${msg.split(token).join('***').slice(0, 1500)}`);
  let v = msg.slice(i + 'PREVIEW_RESULT:'.length);
  const c = v.search(/\nCONTEXT:/); if (c >= 0) v = v.slice(0, c);
  return JSON.parse(v.trim());
}

// ── shaping ────────────────────────────────────────────────────────────────────
function applyOpening(result, variantLines) {
  if (!variantLines) return;
  const add = new Map(variantLines.map((l) => [String(l.code), n(l.qty)]));
  for (const d of result.days) {
    const arts = d.sheet.articles ?? (d.sheet.articles = []);
    const seen = new Set();
    for (const a of arts) {
      const q = add.get(a.code) ?? 0;
      seen.add(a.code);
      a.opening = r3(n(a.opening) + q); a.closing = r3(n(a.closing) + q);
      a.available = r3(n(a.closing) - n(a.reserved)); a.negative = a.closing < 0;
    }
    for (const [code, q] of add) {
      if (seen.has(code) || !q) continue;
      arts.push({ code, name: code, unit: 'КОМ', opening: q, out: 0, back: 0, in: 0, other_out: 0, adjust: 0, closing: q,
                  to_pack: 0, with_courier: 0, reserved: 0, available: q, negative: false });
    }
  }
}

function build(result) {
  const daysArticles = [];
  const summary = [];
  for (const d of result.days) {
    const arts = d.sheet.articles ?? [];
    const t = { day: d.day, articles: arts.length };
    for (const k of ['opening', 'out', 'back', 'in', 'other_out', 'adjust', 'closing', 'to_pack', 'with_courier'])
      t[k] = r3(arts.reduce((s, a) => s + n(a[k]), 0));
    t.negatives = arts.filter((a) => n(a.closing) < 0).length;
    summary.push(t);
    for (const a of arts) daysArticles.push({ day: d.day, code: a.code, name: a.name, unit: a.unit, opening: a.opening, out: a.out,
      back: a.back, in: a.in, other_out: a.other_out, adjust: a.adjust, closing: a.closing, to_pack: a.to_pack, with_courier: a.with_courier });
  }
  const parcels = [];
  for (const p of result.parcels) {
    const s = summary.find((x) => x.day === p.day);
    if (s) Object.assign(s, { parcels: n(p.p.totals?.parcels), parcel_units: n(p.p.totals?.units),
      gift_units: n(p.p.totals?.gift_units), returned_units: n(p.p.totals?.returned_units) });
    for (const dim of ['by_account', 'by_department', 'by_status'])
      for (const x of p.p[dim] ?? []) parcels.push({ day: p.day, dimension: dim.slice(3), key: x.key, parcels: x.parcels, units: x.units });
  }
  // negatives: per article the last day's closing, the first negative day, the lowest closing
  const byArt = new Map();
  for (const r of daysArticles) {
    const e = byArt.get(r.code) ?? { code: r.code, name: r.name, first_negative_day: null, min_closing: Infinity, last_closing: 0 };
    if (n(r.closing) < 0 && !e.first_negative_day) e.first_negative_day = r.day;
    e.min_closing = Math.min(e.min_closing, n(r.closing));
    e.last_closing = n(r.closing);
    byArt.set(r.code, e);
  }
  const negatives = [...byArt.values()].filter((e) => e.min_closing < 0).sort((a, b) => a.last_closing - b.last_closing);
  const unresolved = (result.unresolved ?? []).map((u) => ({ ...u, flags: (u.flags ?? []).join(','),
    unmapped: (u.unmapped ?? []).map((x) => `${x.qty}× ${x.name ?? x.code} (${x.why})`).join('; ') }));
  return { summary, daysArticles, parcels, unresolved, negatives };
}

async function main() {
  const from = arg('from') ?? '2026-09-22';
  const to = arg('to') ?? skopjeToday();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new Refusal('bad --from / --to');
  const preview = !flag('ledger');
  const unapplied = flag('unapplied');
  const outDir = abs(arg('out') ?? join('exports', 'stock', 'preview'));

  let variant = null; let variantLines = null;
  if (arg('opening')) {
    const key = arg('variant');
    if (!key) throw new Refusal('--opening needs --variant=<key>');
    const doc = JSON.parse(readFileSync(abs(arg('opening')), 'utf8'));
    variant = doc.variants?.[key];
    if (!variant) throw new Refusal(`variant ${key} not in ${arg('opening')} (have: ${Object.keys(doc.variants ?? {}).join(', ')})`);
    if ((variant.warehouse ?? 'main') !== 'main') throw new Refusal('only a main-warehouse opening is supported');
    if (variant.at && new Date(variant.at).getTime() !== new Date('2026-09-22T00:00:00+02:00').getTime())
      console.warn(`warning: variant ${key} is at ${variant.at}, not 22.09.2026 00:00 Skopje — it is still added to every day`);
    variantLines = variant.lines ?? [];
    variant = { key, label: variant.label ?? key, lines: variantLines.length, units: variantLines.reduce((s, l) => s + n(l.qty), 0) };
  }
  if (!unapplied && (flag('seed-collabbox') || arg('articles') || arg('recipes') || arg('kits')))
    throw new Refusal('--seed-collabbox / --articles / --recipes / --kits only with --unapplied (nothing is ever written)');

  const query = previewQuery(from, to, preview);
  let result;
  if (unapplied) {
    result = await unappliedResult(query);
  } else {
    const [have] = await runSql(`SELECT to_regprocedure('public.stock_v2_day(date,text,time,boolean,boolean)') IS NOT NULL AS ok`);
    if (!have.ok) { console.error('backfill-preview: stock v2 is not installed — apply 20260945000100…0500, or run with --unapplied'); process.exit(2); }
    [{ j: result }] = await runSql(query);
  }
  applyOpening(result, variantLines);
  const sheets = build(result);

  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `stock-preview-${from}_${to}${variant ? `-${variant.key}` : ''}${unapplied ? '-unapplied' : ''}`);
  const about = {
    generated_at: new Date().toISOString(), from, to, mode: unapplied ? 'unapplied (rolled-back transaction)' : preview ? 'preview (stock_v2_desired)' : 'ledger',
    opening: variant, articles_loaded: result.articles_loaded, recipes_approved: result.recipes_approved, parcel_states: result.states,
    seeds: unapplied ? { seed_collabbox: flag('seed-collabbox'), articles: arg('articles') ?? null, kits: arg('kits') ?? null, recipes: arg('recipes') ?? null } : null,
    note: variant ? 'opening/closing include the variant lines (added client-side at 22.09 00:00)' : 'no opening loaded: balances accumulate from 0 (opening: null)',
  };
  writeFileSync(`${base}.json`, JSON.stringify({ about, ...sheets }, null, 1));

  let xlsx = null;
  try { xlsx = createRequire(join(ROOT, 'package.json'))('xlsx'); } catch { /* CSV fallback below */ }
  if (xlsx) {
    const wb = xlsx.utils.book_new();
    const add = (name, rows) => xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(rows.length ? rows : [{ empty: '' }]), name);
    add('Summary', sheets.summary);
    add('Days×Articles', sheets.daysArticles);
    add('Parcels by day', sheets.parcels);
    add('Unresolved parcels', sheets.unresolved);
    add('Negatives', sheets.negatives);
    add('About', Object.entries(about).map(([k, v]) => ({ key: k, value: typeof v === 'object' ? JSON.stringify(v) : String(v ?? '') })));
    xlsx.writeFile(wb, `${base}.xlsx`);
  } else {
    const csv = (rows) => { if (!rows.length) return ''; const cols = Object.keys(rows[0]);
      return [cols.join(','), ...rows.map((r) => cols.map((c) => JSON.stringify(r[c] ?? '')).join(','))].join('\n'); };
    for (const [k, rows] of Object.entries(sheets)) writeFileSync(`${base}-${k}.csv`, csv(rows));
  }

  const last = sheets.summary.at(-1) ?? {};
  console.log(`stock preview ${from} → ${to} (${about.mode})${variant ? ` + opening ${variant.key} (${variant.lines} lines, ${variant.units} units)` : ' — no opening loaded'}`);
  console.log(`articles loaded ${result.articles_loaded} · recipes approved ${result.recipes_approved} · parcel states ${JSON.stringify(result.states)}`);
  const tot = (k) => r3(sheets.summary.reduce((s, x) => s + n(x[k]), 0));
  console.log(`out ${tot('out')} · back ${tot('back')} · in ${tot('in')} · other out ${tot('other_out')} · parcels ${tot('parcels')}`);
  console.log(`last day ${last.day}: closing ${last.closing} · to pack ${last.to_pack} · with courier ${last.with_courier} · negatives ${last.negatives}`);
  console.log(`unresolved / flagged parcels ${sheets.unresolved.length} · articles ever negative ${sheets.negatives.length}`);
  console.log(`wrote ${base}.json${xlsx ? ` and ${base}.xlsx` : ' and CSVs'}`);
}

main().catch((e) => { console.error(`backfill-preview: ${e?.message ?? e}`); process.exit(2); });
