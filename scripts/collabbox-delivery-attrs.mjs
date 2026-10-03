#!/usr/bin/env node
/**
 * scripts/collabbox-delivery-attrs.mjs — READ-ONLY: the delivery outcome collabBox itself holds per document.
 *
 * Found 03.10.2026 (owner: "провери го тоа"): every sales document carries custom attributes written by the courier
 * integrations — "Delivered", "Return to sender", "Shipment created", "Payed By Kolporter", "Received at Callporter" —
 * also on the days another courier than MEX carried the parcels (Kolporter Post 2024, Eko Logistik 10.2025–01.2026,
 * Jon Express 05–06.2026). The document search shows them as columns when the attribute is added with
 * "Не филтрирај по овој атрибут" (customKeyN / customValueN / customFilterN=ON).
 *
 *   node scripts/collabbox-delivery-attrs.mjs --days-file <csv with a `date` column> [--out dir] [--max-requests 300]
 *   node scripts/collabbox-delivery-attrs.mjs --days 2025-11-10,2024-04-12
 *
 * One search per day (all sales document types of that day), 2,5 s apart, single-threaded, resumable (a saved day is
 * skipped). Only the search form is used (POST Index?comp=searchdoc&action=search, searchMode=search) — nothing is
 * written to collabBox. Output: <out>/<date>.json — document number, type, amount, time, author and the flags; NO
 * customer names or phones are kept. Credentials come from docs/VAULT.md §7 and are never printed.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'http://146.255.89.49:8081/naturatherapy/';
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const OUT = opt('--out', join(ROOT, 'exports', 'collabbox', 'delivery-attrs'));
const MAX = Number(opt('--max-requests', 300));
const PAUSE = Number(opt('--pause-ms', 2500));
const TYPES = (opt('--types', '10036,10050,10106,10055,10111,10114')).split(',');
const ATTRS = ['Delivered', 'Return to sender', 'Shipment created', 'In Delivery', 'Picked Up', 'Problematic', 'Received at MEX station', 'Payed By Kolporter', 'Received at Callporter '];
mkdirSync(OUT, { recursive: true });

let days = [];
if (opt('--days')) days = opt('--days').split(',');
else if (opt('--days-file')) {
  const lines = readFileSync(opt('--days-file'), 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean);
  const head = lines[0].split(','); const di = head.indexOf('date'); const ci = head.indexOf('day_class');
  days = [...new Set(lines.slice(1).map((l) => l.split(',')).filter((c) => ci < 0 || c[ci] !== 'MEX').map((c) => c[di]))];
} else { console.error('usage: --days-file <csv> | --days 2025-11-10,…'); process.exit(2); }
days = days.filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

const vault = readFileSync(join(ROOT, 'docs', 'VAULT.md'), 'utf8');
const user = (vault.match(/\*\*User:\*\* `([^`]+)`/) || [])[1], pass = (vault.match(/\*\*Password:\*\* `([^`]+)`/) || [])[1];
if (!user || !pass) { console.error('collabBox credentials not found in VAULT §7'); process.exit(1); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
let cookie = ''; let requests = 0;

async function req(method, path, form) {
  if (++requests > MAX) throw new Error('request cap reached');
  if (requests > 1) await sleep(PAUSE);
  const body = form ? new URLSearchParams(form).toString() : undefined;
  const r = await fetch(BASE + path, { method, redirect: 'manual', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body });
  const sc = r.headers.get('set-cookie'); if (sc && /JSESSIONID=/.test(sc)) cookie = sc.match(/JSESSIONID=[^;]+/)[0];
  return r.text();
}
async function login() {
  await req('GET', 'Login?');
  const t = await req('POST', 'Login', { company_code: '', username: user, password: pass, browserIsIE: '0' });
  if (!/Index\?/.test(t)) throw new Error('collabBox login failed');
}
const cellsOf = (tr) => [...tr.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((m) => m[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim());

function parse(html) {
  const r1 = html.indexOf('id="row_1"');
  const found = Number(((html.match(/Вкупно пронајдени\s*([\d.,]+)\s*документи/) || [])[1] || '0').replace(/[.,]/g, ''));
  if (r1 < 0) return { found, header: [], docs: [] };
  let header = null; let pos = r1;
  for (let i = 0; i < 8 && !header; i++) {
    pos = html.lastIndexOf('<tr', pos - 1); if (pos < 0) break;
    const c = cellsOf(html.slice(pos, html.indexOf('</tr>', pos)));
    if (c.includes('Автор') && c.includes('Delivered')) header = c;
  }
  if (!header) throw new Error('result header not found (the attribute columns are missing)');
  const idx = (name, nth = 0) => { let k = -1; for (let i = 0; i <= nth; i++) k = header.indexOf(name, k + 1); return k; };
  const col = { title: idx('Наслов'), type: idx('Тип'), amount: idx('Износ'), at: idx('Датум'), author: idx('Автор'),
    delivered: idx('Delivered'), returned: idx('Return to sender'), created: idx('Shipment created'), inDelivery: idx('In Delivery'), pickedUp: idx('Picked Up'),
    problematic: idx('Problematic'), atMex: idx('Received at MEX station'), paidKolporter: idx('Payed By Kolporter'), atKolporter: idx('Received at Callporter') };
  const docs = [];
  for (const m of html.matchAll(/<tr[^>]*id="row_(\d+)"[^>]*>([\s\S]*?)(?=<tr[^>]*id="row_\d+"|<\/table>)/g)) {
    const c = cellsOf(m[0]);
    if (!/^\d{3}-/.test(c[col.title] || '')) continue;
    const f = (k) => (col[k] >= 0 ? (c[col[k]] || '') : '');
    docs.push({ doc: c[col.title], type: c[col.type], amount: Number((c[col.amount] || '0').replace(/[^\d.,-]/g, '').replace(/,/g, '')), at: c[col.at], author: c[col.author],
      delivered: f('delivered'), returned: f('returned'), created: f('created'), inDelivery: f('inDelivery'), pickedUp: f('pickedUp'), problematic: f('problematic'),
      atMex: f('atMex'), paidKolporter: f('paidKolporter'), atKolporter: f('atKolporter') });
  }
  return { found, header, docs };
}

const attrForm = {};
ATTRS.forEach((a, i) => { attrForm[`customKey${i}`] = a; attrForm[`customValue${i}`] = ''; attrForm[`customFilter${i}`] = 'ON'; });
attrForm.number = String(ATTRS.length); attrForm.delcustom = 'none';

const todo = days.filter((d) => !existsSync(join(OUT, `${d}.json`)));
log(`${days.length} days, ${todo.length} to read (${days.length - todo.length} already saved) → ${OUT}`);
if (!todo.length) process.exit(0);
await login();
let n = 0;
for (const d of todo) {
  const dmy = `${d.slice(8, 10)}.${d.slice(5, 7)}.${d.slice(0, 4)}`;
  let html = await req('POST', 'Index?comp=searchdoc&action=search', { searchMode: 'search', chkDocType: 'chk', selectedDocTypes: `,${TYPES.join(',')},`, chkDatumOd: 'chk', datumod: dmy, chkDatumDo: 'chk', datumdo: dmy, limitResults: '0', ...attrForm });
  if (/location\.href='\.\/Login\?'/.test(html)) { await login(); html = await req('POST', 'Index?comp=searchdoc&action=search', { searchMode: 'search', chkDocType: 'chk', selectedDocTypes: `,${TYPES.join(',')},`, chkDatumOd: 'chk', datumod: dmy, chkDatumDo: 'chk', datumdo: dmy, limitResults: '0', ...attrForm }); }
  const p = parse(html);
  if (p.found !== p.docs.length) log(`  ! ${d}: the page says ${p.found} documents, parsed ${p.docs.length}`);
  writeFileSync(join(OUT, `${d}.json`), JSON.stringify({ date: d, found: p.found, docs: p.docs }));
  n++;
  const del = p.docs.filter((x) => x.delivered === 'Da').length, ret = p.docs.filter((x) => x.returned === 'Da').length;
  log(`${d}: ${p.docs.length} documents · Delivered ${del} · Return to sender ${ret} · neither ${p.docs.length - del - ret}  (${n}/${todo.length})`);
}
log(`DONE — ${n} days read, ${requests} requests`);
