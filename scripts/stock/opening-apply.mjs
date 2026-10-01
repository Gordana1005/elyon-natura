/**
 * opening-apply — the 22.09.2026 opening count of Главен магацин (main) into Stock v2, from a Sigma variant the
 * owner picks or from the owner's count sheet. Through stock_v2_count_save() (20260945000400), kind 'opening',
 * counted_at 2026-09-22T00:00:00+02:00 (the morning count, before dispatch). No shebang (repo convention).
 *
 *   node scripts/stock/opening-apply.mjs --variant 04_morning_2209          # DRY (default): the writer's preview
 *   node scripts/stock/opening-apply.mjs --xlsx Magacin-pregled-2026-10-01.xlsx   # the owner's count (yellow column)
 *   node scripts/stock/opening-apply.mjs --variant 04_morning_2209 --apply --actor <owner uuid>   # saves it (approved)
 *   options: --dir exports/stock  --warehouse main  --counted-at <iso>  --note "…"
 *            --sheet "Почетна состојба" --code-col "Шифра" --qty-col "ПОПИС 22.09 (внесете)"  (xlsx: any sheet with a
 *              code column and a quantity column works; a blank quantity = not counted, 0 = counted as none)
 *            --fractional round|floor|skip   a КОМ article must be whole (stock_v2_parse_lines): default round
 *            --show 25                       how many preview lines to print
 *            --with-articles                 DRY only: load articles.json (+ local-articles.json) first in the SAME
 *                                            rolled-back transaction — a preview before mapping-apply has run
 *
 * Variants (openings.json, build_sigma_stock.py): 04_morning_2209 (Sigma 04, documents dated ≤ 21.09) ·
 * 04_end_2209 (≤ 22.09, incl. ТН1 04-00045 04→08) · 04_plus_08_morning_2209 · 08_end_2209. A negative Sigma
 * balance is not a count: it is left out (listed). Only articles that exist in stock_articles can be counted —
 * run mapping-apply first.
 *
 * Safety: Macedonia only; the dry run calls the writer with p_dry = true inside a transaction that is rolled
 * back; --apply needs an owner actor (an owner's opening is approved at once — one approved opening per
 * warehouse, the writer refuses a second). Nothing moves stock until stock_v2 is switched on.
 */
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bold, die, ok, warn, yellow } from '../lib/repair-kit.mjs';
import { OPENING_AT, STOCK_DIR, anyOwner, args, guard, jlit, lit, loadJson, ownerActor, read, txRun, ulit } from './sigma-common.mjs';

/** 1234 · '1234' · '1.234' · '1 234' · '1.234,5' · '12,5' → a number (Macedonian sheets use . for thousands). */
export function parseQty(raw) {
  if (typeof raw === 'number') return raw;
  let t = String(raw).trim().replace(/[\s\u00a0]/g, '');
  if (t.includes(',') && t.includes('.')) t = t.replace(/\./g, '').replace(',', '.');
  else if (t.includes(',')) t = t.replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  return t === '' ? NaN : Number(t);
}

/** Count lines from an xlsx (SheetJS, already a repo dependency). */
async function linesFromXlsx(path, { sheet, codeCol, qtyCol }) {
  const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
  const wb = XLSX.readFile(path);
  const ws = wb.Sheets[sheet] ?? wb.Sheets[wb.SheetNames[0]];
  if (!ws) die(`${path}: no sheet "${sheet}"`);
  const grid = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  const hi = grid.findIndex((row) => row && row.some((c) => String(c ?? '').trim() === codeCol) && row.some((c) => String(c ?? '').trim() === qtyCol));
  if (hi < 0) die(`${path}: no header row with "${codeCol}" and "${qtyCol}" (use --code-col / --qty-col)`);
  const head = grid[hi].map((c) => String(c ?? '').trim());
  const ci = head.indexOf(codeCol);
  const qi = head.indexOf(qtyCol);
  const out = [];
  for (const row of grid.slice(hi + 1)) {
    const code = String(row?.[ci] ?? '').trim();
    const raw = row?.[qi];
    if (!/^[0-9]{6}$|^L[0-9]{5}$/.test(code)) continue;          // the totals row, notes
    if (raw === null || raw === undefined || String(raw).trim() === '') continue;   // not counted
    const qty = parseQty(raw);
    if (!Number.isFinite(qty)) die(`${path}: ${code} has a quantity that is not a number: ${raw}`);
    out.push({ code, qty });
  }
  return out;
}

/** Clean lines for the writer: one per article, no negatives, whole КОМ units (pure — unit-testable). */
export function cleanLines(lines, units, fractional) {
  const by = new Map();
  for (const l of lines) by.set(l.code, (by.get(l.code) ?? 0) + Number(l.qty));
  const out = [];
  const notes = { negative: [], fractional: [], unknown: [], zero: 0 };
  for (const [code, q0] of by) {
    if (!units.has(code)) { notes.unknown.push(code); continue; }
    let q = Math.round(q0 * 1000) / 1000;
    if (q < 0) { notes.negative.push({ code, qty: q }); continue; }
    const unit = String(units.get(code) ?? 'КОМ').toUpperCase();
    if (['КОМ', 'KOM', 'PCS', 'ПАК'].includes(unit) && q !== Math.trunc(q)) {
      notes.fractional.push({ code, qty: q });
      if (fractional === 'skip') continue;
      q = fractional === 'floor' ? Math.floor(q) : Math.round(q);
    }
    if (q === 0) notes.zero++;
    out.push({ code, qty: q });
  }
  out.sort((a, b) => (a.code < b.code ? -1 : 1));
  return { lines: out, notes };
}

async function main() {
  const a = args(process.argv.slice(2), {
    flags: ['apply', 'help', 'with-articles'],
    values: ['actor', 'dir', 'variant', 'xlsx', 'warehouse', 'counted-at', 'note', 'sheet', 'code-col', 'qty-col', 'fractional', 'show'],
  });
  if (a.help) { console.log('see the header of scripts/stock/opening-apply.mjs'); return; }
  if (!!a.variant === !!a.xlsx) die('give exactly one of --variant <key> or --xlsx <file>.');
  if (a.apply && !a.actor) die('--apply needs --actor <auth uuid of an owner>.');
  if (a.apply && a['with-articles']) die('--with-articles is for a dry preview only — load the mapping with mapping-apply.');
  const dir = a.dir ?? STOCK_DIR;
  const fractional = a.fractional ?? 'round';
  if (!['round', 'floor', 'skip'].includes(fractional)) die('--fractional must be round, floor or skip');
  const warehouse = a.warehouse ?? 'main';
  const countedAt = a['counted-at'] ?? OPENING_AT;

  let raw;
  let source;
  let sourceRef;
  if (a.variant) {
    const o = loadJson(dir, 'openings.json');
    const v = o.variants[a.variant];
    if (!v) die(`--variant: ${a.variant} is not one of ${Object.keys(o.variants).join(', ')}`);
    raw = [...v.lines, ...(v.negatives ?? [])];
    source = 'sigma_variant';
    sourceRef = `${a.variant} · ${v.label} · Sigma export ${o.sigma_export}`;
    console.log(bold(`\nVariant ${a.variant}: ${v.label}`));
    console.log(`  Sigma totals: ${JSON.stringify(v.totals)}`);
  } else {
    const path = isAbsolute(a.xlsx) ? a.xlsx : (existsSync(resolve(a.xlsx)) ? resolve(a.xlsx) : join(dir, a.xlsx));
    if (!existsSync(path)) die(`no file ${path}`);
    raw = await linesFromXlsx(path, { sheet: a.sheet ?? 'Почетна состојба', codeCol: a['code-col'] ?? 'Шифра',
      qtyCol: a['qty-col'] ?? 'ПОПИС 22.09 (внесете)' });
    source = 'xlsx';
    sourceRef = `${path.split(/[\\/]/).pop()} (owner count sheet)`;
    console.log(bold(`\nCount sheet ${path}: ${raw.length} counted lines`));
    if (!raw.length) die('the count column is empty — nothing to load.');
  }

  await guard();
  const units = new Map((await read('select code, unit from public.stock_articles')).map((r) => [r.code, r.unit]));
  const pre = [];
  if (a['with-articles']) {
    const arts = loadJson(dir, 'articles.json');
    const local = loadJson(dir, 'local-articles.json', { optional: true }) ?? [];
    for (const x of [...arts, ...local]) if (!units.has(x.code)) units.set(x.code, x.unit);
    pre.push({ k: 'articles', sql: `public.stock_articles_upsert(${jlit(arts)}, 'sigma', ACTOR, false)` });
    if (local.length) pre.push({ k: 'local', sql: `public.stock_articles_upsert(${jlit(local.map(({ code, name, unit }) => ({ code, name, unit })))}, 'local', ACTOR, false)` });
  }
  if (!units.size) die('stock_articles is empty — run scripts/stock/mapping-apply.mjs --apply first (or preview with --with-articles).');
  const { lines, notes } = cleanLines(raw, units, fractional);
  console.log(`  lines to count: ${lines.length} · units ${lines.reduce((s, l) => s + l.qty, 0).toLocaleString('de-DE')}`);
  if (notes.negative.length) warn(`${notes.negative.length} negative Sigma balance(s) left out: ${notes.negative.map((x) => `${x.code} ${x.qty}`).join(', ')}`);
  if (notes.fractional.length) warn(`${notes.fractional.length} fractional КОМ quantity(ies) → ${fractional}: ${notes.fractional.map((x) => `${x.code} ${x.qty}`).join(', ')}`);
  if (notes.unknown.length) warn(`${notes.unknown.length} code(s) are not stock articles (left out): ${notes.unknown.slice(0, 20).join(', ')}`);

  const actor = a.apply ? await ownerActor(a.actor) : await anyOwner();
  const note = a.note ?? (a.variant ? `Opening 22.09.2026 from the Sigma variant ${a.variant} (owner's choice)` : 'Opening 22.09.2026 from the owner\'s count sheet');
  const call = (dry) => `public.stock_v2_count_save(${lit(warehouse)}, ${lit(countedAt)}::timestamptz, 'opening', ${jlit(lines)}, ` +
    `${lit(source)}, ${lit(sourceRef)}, false, ${lit(note)}, ${ulit(actor.id)}, true, ${dry})`;
  // the preview is the writer itself with p_dry (inside a rolled-back transaction); --apply saves
  const steps = [...pre.map((x) => ({ ...x, sql: x.sql.replace('ACTOR', ulit(actor.id)) })), { k: 'count', sql: call(!a.apply) }];
  const out = await txRun(steps, { dry: !a.apply });
  const res = out.find((r) => r.k === 'count')?.v;
  if (!res?.ok) die(`stock_v2_count_save refused: ${JSON.stringify(res).slice(0, 800)}`);
  const t = res.totals ?? {};
  console.log(bold('\nThe writer says:'));
  console.log(`  ${res.dry ? 'preview' : `saved count ${res.count_id} (${res.status})`} · stock v2 ${res.preview ? 'OFF (system qty = preview)' : 'ON'}`);
  console.log(`  lines ${t.lines} · system ${Number(t.system_qty).toLocaleString('de-DE')} · counted ${Number(t.counted_qty).toLocaleString('de-DE')} · diff ${Number(t.diff).toLocaleString('de-DE')}` +
    (t.value_diff_mkd != null ? ` · value diff ${Number(t.value_diff_mkd).toLocaleString('de-DE')} ден` : ''));
  if (res.warnings?.length) console.log(yellow(`  warnings: ${res.warnings.join(' · ')}`));
  const show = Number(a.show ?? 25);
  for (const l of (res.lines ?? []).slice(0, show)) {
    console.log(`  ${l.code} ${String(l.name ?? '').slice(0, 36).padEnd(36)} system ${String(l.system_qty).padStart(8)} counted ${String(l.counted_qty).padStart(8)} diff ${String(l.diff).padStart(8)}`);
  }
  if (!a.apply) {
    console.log(yellow(`\n  DRY RUN — nothing saved (actor for the preview: ${actor.email}).`));
    console.log(yellow(`  To save: node scripts/stock/opening-apply.mjs ${a.variant ? `--variant ${a.variant}` : `--xlsx ${a.xlsx}`} --apply --actor <owner auth uuid>`));
  } else {
    ok(bold(`opening saved by ${actor.email}: count ${res.count_id}, ${res.status}.`));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
