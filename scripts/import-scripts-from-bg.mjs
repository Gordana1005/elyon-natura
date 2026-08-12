#!/usr/bin/env node
/**
 * Copy the MACEDONIAN and ALBANIAN call scripts out of the Bulgarian CRM into
 * the Macedonian one.
 *
 *   node scripts/import-scripts-from-bg.mjs            # dry run, writes nothing
 *   node scripts/import-scripts-from-bg.mjs --commit   # write MK call_scripts
 *
 * Why this exists: the Macedonian fork inherited BULGARIAN prose sitting in its
 * `mk` base columns, with `translations` completely empty and zero structured
 * helpers — so agents read Bulgarian off the screen, and the MK/AL flags on the
 * /calls panel both rendered the same Bulgarian text. Bulgaria had already had
 * every script professionally translated into Macedonian and Albanian
 * (translations.mk / translations.sq), so that is the source of truth and there
 * is nothing to re-author.
 *
 * The mapping is a LANGUAGE PROMOTION, not a straight row copy:
 *
 *     BG translations.mk  ->  MK base columns (title/description/script_text/helpers)
 *     BG translations.sq  ->  MK translations.sq
 *     BG base (Bulgarian) ->  dropped
 *     BG translations.en  ->  dropped
 *
 * en/bg are deliberately NOT imported: Macedonia writes scripts in Macedonian and
 * Albanian only (operator rule 2026-08-12), which is why the editor offers just
 * those two. See src/lib/callScripts.ts (BASE_SCRIPT_LANG / SCRIPT_LANGS).
 *
 * ── BULGARIA SAFETY ────────────────────────────────────────────────────────
 * Bulgaria is a separate LIVE business and is off limits for writes. This script
 * touches it with HTTP GET only, through one helper (bgGet) that hard-codes the
 * method. Every write goes to Macedonia. The guards below refuse to run if the
 * two projects are ever transposed. Same pattern as import-costs-from-bg.mjs.
 *
 * Rollback: this overwrites script_text/title/description/helpers/translations on
 * matched rows. Take a copy first if you care about the inherited Bulgarian text:
 *   select id, title, script_text, helpers, translations from call_scripts;
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MK_REF = 'bmfxhgznttcnnlqloqzp';
const BG_REF = 'sxymaloycddnoxudxaqp';
const BG_ENV = 'C:/Users/Mile/Desktop/elyoncrm/.env';
const COMMIT = process.argv.includes('--commit');

const fail = (m) => { console.error(`\x1b[31m✗ ${m}\x1b[0m`); process.exit(1); };

const parseEnv = (path) => {
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"]*)"?\s*$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
};

// Guard 1: this repo must be the Macedonian one.
const toml = readFileSync(join(root, 'supabase', 'config.toml'), 'utf8');
const ref = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
if (ref !== MK_REF) fail(`config.toml project_id = "${ref}", expected "${MK_REF}"`);

const mkEnv = parseEnv(join(root, '.env'));
const MK_URL = mkEnv.SUPABASE_URL || mkEnv.VITE_SUPABASE_URL;
const MK_KEY = mkEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!MK_URL || !MK_KEY) fail('MK SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing');

// Guard 2: the write target must be Macedonia and must not be Bulgaria.
if (!MK_URL.includes(MK_REF)) fail(`write target ${MK_URL} is not the MK project`);
if (MK_URL.includes(BG_REF)) fail('REFUSING: the write target is Bulgaria.');

const bgEnv = parseEnv(BG_ENV);
const BG_URL = bgEnv.SUPABASE_URL || bgEnv.VITE_SUPABASE_URL;
const BG_KEY = bgEnv.SUPABASE_SERVICE_ROLE_KEY;
if (!BG_URL || !BG_KEY) fail(`BG env incomplete at ${BG_ENV}`);
// Guard 3: the read source really is Bulgaria (and not, say, MK twice over).
if (!BG_URL.includes(BG_REF)) fail(`read source ${BG_URL} is not the BG project`);

/** The ONLY way this script talks to Bulgaria. Method is hard-coded to GET. */
async function bgGet(path) {
  const r = await fetch(`${BG_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: { apikey: BG_KEY, Authorization: `Bearer ${BG_KEY}` },
  });
  if (!r.ok) fail(`BG GET ${path} -> ${r.status} ${await r.text()}`);
  return r.json();
}

async function mk(path, init = {}) {
  const r = await fetch(`${MK_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: MK_KEY, Authorization: `Bearer ${MK_KEY}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  if (!r.ok) fail(`MK ${init.method || 'GET'} ${path} -> ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

// Titles drifted slightly between the two catalogues. Anything not resolved by
// exact or normalised match is listed as UNMATCHED rather than guessed at.
const TITLE_ALIASES = {
  'Diet Combo – 2xDiet Shake + Slim Complex + Slim Fiber': 'Diet Combo –Diet Shake + Slim Complex + Slim Fiber',
};

// BG's translations carry only description + script_text — never a title — so the
// three titles with a Bulgarian tail would survive the import and keep showing
// Bulgarian in the panel header. Only the descriptive tail is translated; the
// brand name and pack size are left exactly as they are.
const TITLE_MK = {
  'Curcumactiv 500ml – Сироп с куркумин против болки и възпаления':
    'Curcumactiv 500ml – Сируп со куркумин против болки и воспаленија',
  'Hepatol Forte 30 caps – За черен дроб и детоксикация':
    'Hepatol Forte 30 caps – За црн дроб и детоксикација',
  'Snail Complex 30 caps – Екстракт от охлюви за стави':
    'Snail Complex 30 caps – Екстракт од полжави за зглобови',
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
const hasText = (v) => typeof v === 'string' && v.trim().length > 0;

const bgRows = await bgGet('call_scripts?select=*');
const mkRows = await mk('call_scripts?select=*');
console.log(`BG scripts: ${bgRows.length} · MK scripts: ${mkRows.length}\n`);

const byExact = new Map(bgRows.map(r => [r.title, r]));
const byNorm = new Map(bgRows.map(r => [norm(r.title), r]));

const planned = [];
const skipped = [];

for (const row of mkRows) {
  const alias = TITLE_ALIASES[row.title];
  const src = byExact.get(row.title) || byNorm.get(norm(alias || row.title));
  if (!src) { skipped.push([row.title, 'no BG script with this title']); continue; }

  const tmk = src.translations?.mk;
  const tsq = src.translations?.sq;
  if (!tmk || !hasText(tmk.script_text)) {
    skipped.push([row.title, 'BG has no Macedonian translation']);
    continue;
  }

  // BG's Macedonian becomes MK's BASE. Per field, so a translated title that was
  // never filled in keeps the existing one rather than blanking it.
  const patch = {
    title: hasText(tmk.title) ? tmk.title : (TITLE_MK[row.title] ?? row.title),
    description: hasText(tmk.description) ? tmk.description : row.description,
    script_text: tmk.script_text,
    helpers: Array.isArray(tmk.helpers) && tmk.helpers.length ? tmk.helpers : (row.helpers ?? []),
    // Albanian rides along as the one translation MK keeps. Existing MK
    // translations for other languages are dropped on purpose.
    translations: (tsq && (hasText(tsq.script_text) || hasText(tsq.title))) ? { sq: tsq } : {},
  };
  planned.push({ row, src, patch, viaAlias: !!alias && row.title !== src.title });
}

for (const p of planned) {
  const bgHelpers = Array.isArray(p.patch.helpers) ? p.patch.helpers.length : 0;
  console.log(
    `→ ${p.row.title}\n` +
    `    title    : ${p.patch.title}\n` +
    `    script   : ${String(p.row.script_text || '').length}ch (bg-prose) -> ${p.patch.script_text.length}ch (Macedonian)\n` +
    `    helpers  : ${(p.row.helpers || []).length} -> ${bgHelpers}\n` +
    `    albanian : ${p.patch.translations.sq ? `${p.patch.translations.sq.script_text?.length || 0}ch` : 'none in BG'}` +
    (p.viaAlias ? `\n    ⚠ matched via alias -> BG "${p.src.title}" — check this one by eye` : ''),
  );
}

if (skipped.length) {
  console.log('\nNot imported:');
  for (const [t, why] of skipped) console.log(`  · ${t} — ${why}`);
}

console.log(`\n${planned.length} script(s) would be updated, ${skipped.length} left alone.`);

if (!COMMIT) {
  console.log('\nDry run — nothing written. Re-run with --commit to apply.');
  process.exit(0);
}

let done = 0;
for (const p of planned) {
  await mk(`call_scripts?id=eq.${p.row.id}`, { method: 'PATCH', body: JSON.stringify(p.patch) });
  done++;
}
console.log(`\n\x1b[32m✓ updated ${done} script(s) in Macedonia.\x1b[0m Bulgaria was read-only throughout.`);
