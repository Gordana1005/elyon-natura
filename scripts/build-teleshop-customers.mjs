#!/usr/bin/env node
/**
 * build-teleshop-customers — the CUSTOMER side of the teleshop import, as a clean file.
 *
 *   node scripts/build-teleshop-customers.mjs                      # read CRM, write both files
 *   node scripts/build-teleshop-customers.mjs --db-cache <file>    # reuse a saved CRM read (or save one)
 *   node scripts/build-teleshop-customers.mjs --komitenti <csv> --orders-dir <dir> --out-dir <dir>
 *
 * READ-ONLY. Pinned to Macedonia (bmfxhgznttcnnlqloqzp; refused unless supabase/config.toml agrees).
 * Every statement is a single SELECT/WITH checked by assertReadOnly() AND sent with read_only: true,
 * so Postgres refuses a write that slipped past the text check. The token is never printed.
 *
 * READS    C:\Users\Mile\collab_out\08-komitenti-klienti\komitenti_full.csv            the komitent registry (UTF-8 BOM)
 *          C:\Users\Mile\collab_out\99-arhiva-surovo-prevzemanje\orders\type_10036.csv / 10050  the teleshop document headers
 *          public.orders (per last-8 key), public.customer_profiles, public.report_excluded_phones,
 *          public.mk_settlements
 * WRITES   exports/teleshop/customers-clean.json   one row per komitent on a teleshop document —
 *                                                  consumed by scripts/import-teleshop-collabbox.mjs
 *          exports/teleshop/customers-report.xlsx   the owner's review (Macedonian)
 *
 * The rules live in scripts/lib/teleshop-customers.mjs (pure, tested in
 * src/lib/teleshopCustomers.test.ts).
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as XLSX from 'xlsx';
import { buildTeleshopCustomers, RULES_VERSION, SKIP_REASONS } from './lib/teleshop-customers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REF = 'bmfxhgznttcnnlqloqzp';            // Macedonia — the ONLY project this script reads
const FORBIDDEN_REF = 'sxymaloycddnoxudxaqp';  // live Bulgaria — never
const API = `https://api.supabase.com/v1/projects/${REF}/database/query`;
const DEFAULT_KOMITENTI = 'C:/Users/Mile/collab_out/08-komitenti-klienti/komitenti_full.csv';
const DEFAULT_ORDERS_DIR = 'C:/Users/Mile/collab_out/99-arhiva-surovo-prevzemanje/orders';

// ── args ────────────────────────────────────────────────────────────────────
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const next = process.argv[i + 1];
  if (next && !next.startsWith('--')) { args[a.slice(2)] = next; i++; } else args[a.slice(2)] = true;
}
const OUT_DIR = args['out-dir'] || join(ROOT, 'exports', 'teleshop');

// ── guard + read-only SQL ───────────────────────────────────────────────────
let TOKEN = null;
const scrub = (s) => (TOKEN ? String(s).split(TOKEN).join('***') : String(s));
function loadToken() {
  const toml = readFileSync(join(ROOT, 'supabase', 'config.toml'), 'utf8');
  const projectId = toml.match(/^\s*project_id\s*=\s*"([^"]+)"/m)?.[1];
  if (projectId !== REF) throw new Error(`supabase/config.toml project_id = "${projectId}", expected "${REF}" (Macedonia) — refusing`);
  if (API.includes(FORBIDDEN_REF)) throw new Error('refusing: Bulgarian project ref');
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*SUPABASE_ACCESS_TOKEN\s*=\s*"?([^"\r\n]*)"?\s*$/);
    if (m) TOKEN = m[1].trim();
  }
  if (!TOKEN) throw new Error('SUPABASE_ACCESS_TOKEN missing in .env');
}
const WRITE_WORD = /\b(insert|update|delete|merge|upsert|drop|alter|create|truncate|grant|revoke|copy|call|do|execute|prepare|vacuum|analy[sz]e|cluster|reindex|refresh|comment|lock|listen|notify|set|begin|commit|rollback|into)\b/i;
function assertReadOnly(sql) {
  const body = sql.replace(/--.*$/gm, '').replace(/'(?:[^']|'')*'/g, "''").trim();
  if (!/^(select|with)\b/i.test(body) || body.replace(/;\s*$/, '').includes(';') || WRITE_WORD.test(body)) throw new Error(`not a read-only statement: ${sql.slice(0, 80)}…`);
}
async function sqlRead(sql) {
  assertReadOnly(sql);
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(API, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ query: sql, read_only: true }) });
    const text = await res.text();
    if (res.ok) return JSON.parse(text);
    if (attempt >= 4 || ![429, 500, 502, 503, 504].includes(res.status)) throw new Error(scrub(`SQL ${res.status}: ${text.slice(0, 300)}`));
    await new Promise((r) => setTimeout(r, 1500 * attempt));
  }
}

const crmPageSql = (digit) => `
with o as (
  select right(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 8) as p8, customer_phone, customer_name,
         customer_city, mex_city_name, status::text as st, trash_reason::text as tr, created_at, external_source
    from public.orders
   where customer_phone is not null
     and right(regexp_replace(customer_phone, '[^0-9]', '', 'g'), 1) = '${digit}'
)
select p8, count(*)::int as n,
       mode() within group (order by customer_phone) as top_phone,
       count(distinct customer_phone)::int as n_spellings,
       (array_agg(customer_name order by created_at desc))[1] as last_name,
       (array_agg(distinct customer_name))[1:6] as names,
       (array_agg(customer_city order by created_at desc) filter (where coalesce(btrim(customer_city), '') <> ''))[1] as last_city,
       (array_agg(customer_city order by created_at desc) filter (where coalesce(btrim(customer_city), '') <> '' and external_source is distinct from 'altercpa'))[1:4] as cities_trusted,
       (array_agg(customer_city order by created_at desc) filter (where coalesce(btrim(customer_city), '') <> '' and external_source = 'altercpa'))[1:4] as cities_cpa,
       (array_agg(mex_city_name order by created_at desc) filter (where coalesce(btrim(mex_city_name), '') <> ''))[1:4] as mex_cities,
       min(created_at)::date::text as first_at, max(created_at)::date::text as last_at,
       count(*) filter (where st = 'trashed')::int as trashed,
       count(*) filter (where st = 'trashed' and tr in ('wrong_person', 'wrong_number'))::int as wrong,
       count(*) filter (where st = 'paid')::int as paid,
       count(*) filter (where external_source = 'collabbox')::int as cb,
       string_agg(distinct tr, ',') as trash_reasons
  from o where length(p8) = 8 group by p8`;

async function readDb() {
  loadToken();
  const crm = [];
  for (let d = 0; d <= 9; d++) { const rows = await sqlRead(crmPageSql(d)); crm.push(...rows); process.stdout.write(`\r  CRM customers by last-8 … ${crm.length}`); }
  process.stdout.write('\n');
  const profiles = await sqlRead(`select right(regexp_replace(phone, '[^0-9]', '', 'g'), 8) as p8, phone, customer_name, city
    from public.customer_profiles where length(regexp_replace(phone, '[^0-9]', '', 'g')) >= 8`);
  const excluded = (await sqlRead('select phone8 from public.report_excluded_phones order by 1')).map((r) => r.phone8);
  const settlements = await sqlRead(`select s.id, s.name, s.name_norm, s.kind, par.name_norm as parent_norm
    from public.mk_settlements s left join public.mk_settlements par on par.id = s.parent_id order by s.id`);
  return { read_at: new Date().toISOString(), crm, profiles, excluded, settlements };
}

// ── CSV ─────────────────────────────────────────────────────────────────────
function csvObjects(text) {
  const rows = [];
  let row = [];
  let f = '';
  let q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  const out = [];
  for (const r of rows) { if (r.length === 1 && r[0] === '') continue; const o = {}; head.forEach((h, i) => { o[h] = r[i] ?? ''; }); out.push(o); }
  return out;
}
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

// ── Macedonian labels ───────────────────────────────────────────────────────
const STATUS_MK = { import: 'Внеси (нов купувач)', merge_existing: 'Спои со постоечки во CRM', skip: 'Прескокни' };
const REASON_MK = {
  new_customer: 'Нов купувач',
  new_customer_merged: 'Нов купувач — повеќе коминтенти на ист телефон, споени',
  existing_crm_customer: 'Веќе постои во CRM (ист телефон, последни 8 цифри)',
  existing_crm_profile: 'Постои само профил во CRM (без нарачки)',
  not_in_registry: 'Коминтентот не постои во регистарот',
  employee: 'Вработен',
  operator_account: 'Сметка на оператор (нарачките ги пишува самата на свое име)',
  company: 'Фирма / продавница / институција',
  test_name: 'Тест запис',
  deceased: 'Починат (белешка на операторот)',
  do_not_contact: 'Да не се контактира (белешка на операторот)',
  wrong_number: 'Погрешен број (белешка на операторот)',
  do_not_ship: 'Да не се праќа (белешка на операторот)',
  junk_name: 'Неважечко име (една буква, случајни знаци)',
  owner_test_phone: 'Тест-телефон на сопственикот (report_excluded_phones)',
  no_valid_phone: 'Нема валиден македонски број',
  phone_marked_deceased: 'Истиот телефон е означен „починат“ кај друг коминтент',
  phone_marked_do_not_contact: 'Истиот телефон е означен „да не се контактира“ кај друг коминтент',
  phone_marked_do_not_ship: 'Истиот телефон е означен „да не се праќа“ кај друг коминтент',
  phone_of_employee: 'Телефонот е на вработен / оператор',
  no_teleshop_order_document: 'Нема телешоп нарачка (серија 9100/9102) со износ > 0',
};
const PHONE_WHY_MK = {
  empty: 'празно', no_digits: 'нема цифри', too_short: 'прекраток — недостасуваат цифри', too_long: 'предолг — вишок цифри',
  not_mk_range: 'не е македонски опсег (07X, 02, 03[1-4], 04[2-8])', foreign: 'странски број', scientific: 'оштетен (научна нотација)',
  placeholder_zeros: 'лажен број (нули)', placeholder_repeated: 'лажен број (исти цифри)', placeholder_pattern: 'лажен број (шема)',
  placeholder_sequence: 'лажен број (123456)',
};
const FIELD_MK = { mobilen: 'Мобилен', telefon: 'Телефон', faks: 'Факс', lice_kontakt: 'Лице за контакт', name: 'Име', address: 'Адреса' };
const MATCH_MK = { same: 'исто', partial: 'делумно', different: 'различно', unknown: 'непознато', altercpa_form_only: 'само AlterCPA формулар (непроверено)' };
const FLAG_MK = {
  legacy_vraboten_da: '„Вработен = Да“ на стариот регистар (Шифра < 40.000) — застарена ознака, не е вработен',
  name_matches_own_author: 'Името е исто со авторот на еден негов документ',
  returns_orders: 'Враќа нарачки (белешка)', call_time_note: 'Белешка за време на јавување', delivery_note: 'Белешка за достава',
  weak_name: 'Само едно име / фрагмент', no_person_name: 'Нема име на лице во записот',
  name_phone_removed: 'Телефон отстранет од името', name_homoglyph: 'Латинични букви во кирилско име — поправено',
  name_digit_typo: 'Цифра во името — поправено', name_caps_lock: 'Caps Lock — поправено', name_glued_words: 'Споени зборови — раздвоени',
  name_spaced_letters: 'Букви со празни места — споени', phone_from_notes: 'Број од име / адреса / белешка',
  primary_phone_from_notes: 'Главниот број е од име / адреса / белешка', letter_o_for_zero: 'Буква О наместо 0',
  vanity_number: 'Број со исти цифри (070333333) — вистински, провери', some_phone_rejected: 'Дел од броевите одбиени',
  near_duplicate_phones: 'Два броја што се разликуваат во една цифра', foreign_address: 'Адреса во странство',
  primary_by_crm_match: 'Избран бројот што го знае CRM', owner_test_phone_also_listed: 'Има и тест-телефон на сопственикот',
  crm_phone_noncanonical: 'Бројот во CRM не е во +389XXXXXXXX облик', crm_trashed_wrong_person_or_number: 'Во CRM има нарачка во Trash: погрешно лице / број',
  crm_polluted_twin: 'Во CRM постои оштетена верзија на бројот (вишок цифра)', phone_marked_wrong_number_elsewhere: 'Друг коминтент на истиот број е „погрешен број“',
  notes_in_other_fields: 'Белешки во други полиња (Ime_lat, Лице за контакт, Факс, Даночен број)',
};

// ── the report ──────────────────────────────────────────────────────────────
function writeReport(path, rows, stats, meta) {
  const wb = XLSX.utils.book_new();
  const add = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    if (aoa.length > 1 && aoa[0].length) ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: aoa.length - 1, c: aoa[0].length - 1 } }) };
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const phonesOf = (r) => r.phone_sources.map((p) => `${p.e164} (${FIELD_MK[p.field]})`).join('; ');
  const rejectsOf = (r) => r.phone_rejects.map((x) => `„${x.raw}“ ${FIELD_MK[x.field]}: ${PHONE_WHY_MK[x.why] ?? x.why}${x.country ? ` ${x.country}` : ''}`).join('; ');
  const notesOf = (r) => [r.name_note, ...(r.extra_notes || []).map((n) => `${n.field}: ${n.text}`)].filter(Boolean).join(' · ');
  const flagsOf = (r) => r.flags.map((f) => FLAG_MK[f] ?? f).join('; ');
  const skip = rows.filter((r) => r.status === 'skip');
  const liveGroups = new Map();
  for (const r of rows) if (r.status !== 'skip' && r.phone8) (liveGroups.get(r.phone8) ?? liveGroups.set(r.phone8, []).get(r.phone8)).push(r);
  const existingInCrmSkipped = skip.filter((r) => r.crm && ['deceased', 'do_not_contact', 'do_not_ship', 'wrong_number', 'phone_marked_deceased', 'phone_marked_do_not_contact', 'phone_marked_do_not_ship'].includes(r.reason));

  // Преглед
  const o = [
    ['Преглед — купувачи од телешоп документите (collabBox 10036 Нарачка in + 10050 Нарачка out)'],
    [`Правила: ${RULES_VERSION} · CRM прочитан: ${meta.db_read_at} · изработено: ${meta.generated_at}`],
    [],
    ['Показател', 'Број'],
    ['Коминтенти на телешоп документи', stats.komitenti],
    ['… со барем еден валиден македонски број', stats.with_valid_phone],
    ['Купувачи (еден телефон = еден купувач) — вкупно', stats.customers.total],
    ['… нови (ги нема во CRM)', stats.customers.new],
    ['… веќе постојат во CRM', stats.customers.existing],
    ['Коминтенти споени во друг (ист телефон)', stats.customers.komitenti_folded],
    ['Купувачи составени од 2+ коминтенти', stats.customers.multi_komitent_customers],
    ['Прескокнати коминтенти', stats.by_status.skip ?? 0],
    ['Прескокнати, а веќе се во CRM со белешка „починат / да не се контактира / погрешен број“', existingInCrmSkipped.length],
    [],
    ['Статус', 'Коминтенти'],
    ...Object.entries(stats.by_status).map(([k, v]) => [STATUS_MK[k] ?? k, v]),
    [],
    ['Причина (главна)', 'Код', 'Коминтенти', 'Износ на нивните телешоп документи (ден.)'],
    ...Object.entries(stats.by_reason).sort((a, b) => b[1] - a[1]).map(([k, v]) => [REASON_MK[k] ?? k, k, v, stats.skipped_value_mkd[k] ?? '']),
    [],
    ['Постоечки во CRM: име', 'Коминтенти'],
    ...Object.entries(stats.existing_name_match).map(([k, v]) => [MATCH_MK[k] ?? k, v]),
    [],
    ['Постоечки во CRM: град', 'Коминтенти'],
    ...Object.entries(stats.existing_city_match).map(([k, v]) => [MATCH_MK[k] ?? k, v]),
    [],
    ['Ознаки (не се причина за прескокнување)', 'Код', 'Коминтенти'],
    ...Object.entries(stats.flags).sort((a, b) => b[1] - a[1]).map(([k, v]) => [FLAG_MK[k] ?? k, k, v]),
  ];
  // top cities
  const cities = new Map();
  for (const r of rows) {
    if (r.status === 'skip' || !r.city_key) continue;
    const c = cities.get(r.city_key) ?? cities.set(r.city_key, { names: new Map(), n: 0, nw: 0, ex: 0 }).get(r.city_key);
    c.n++; if (r.status === 'import') c.nw++; else c.ex++;
    c.names.set(r.city, (c.names.get(r.city) || 0) + 1);
  }
  o.push([], ['Најчести градови (внесени + споени)', 'Клуч', 'Коминтенти', 'Нови', 'Постоечки']);
  for (const [k, c] of [...cities].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) o.push([[...c.names].sort((a, b) => b[1] - a[1])[0][0], k, c.n, c.nw, c.ex]);
  add('Преглед', o, [70, 30, 14, 22, 12]);

  // Примери — up to 15 per reason
  const ex = [['Причина', 'Шифра', 'Име (како што е внесено)', 'Име (исчистено)', 'Броеви (прифатени)', 'Одбиени броеви', 'Град', 'Белешки', 'Документи', 'Износ (ден.)']];
  for (const reason of [...SKIP_REASONS, 'existing_crm_customer', 'new_customer_merged', 'new_customer']) {
    const list = rows.filter((r) => r.reason === reason);
    const step = Math.max(1, Math.floor(list.length / 15));
    for (let i = 0; i < list.length && i / step < 15; i += step) {
      const r = list[i];
      ex.push([REASON_MK[reason] ?? reason, r.komitent_id, r.name_raw, r.name, phonesOf(r), rejectsOf(r), r.city, notesOf(r), r.docs.valued, r.docs.value_mkd]);
    }
  }
  add('Примери', ex, [40, 9, 45, 30, 40, 40, 16, 50, 10, 12]);

  // Одбиени броеви
  const rj = [['Шифра', 'Име', 'Поле', 'Внесено', 'Причина', 'Земја', 'Прифатени броеви', 'Статус на коминтентот', 'Причина за статус']];
  for (const r of rows) for (const x of r.phone_rejects) rj.push([r.komitent_id, r.name_raw, FIELD_MK[x.field], x.raw, PHONE_WHY_MK[x.why] ?? x.why, x.country ?? '', r.phones.join('; '), STATUS_MK[r.status], REASON_MK[r.reason] ?? r.reason]);
  add('Одбиени броеви', rj, [9, 35, 14, 22, 40, 8, 30, 22, 40]);

  // Дупликати
  const dp = [['Телефон', 'Коминтенти', 'Шифри', 'Имиња', 'Избрано име', 'Имињата се', 'Статус', 'Постои во CRM']];
  for (const [p8, list] of [...liveGroups].filter(([, l]) => l.length > 1).sort((a, b) => b[1].length - a[1].length)) {
    const r0 = list[0];
    dp.push([r0.phone_e164, list.length, list.map((r) => r.komitent_id).join(', '), list.map((r) => r.name).join(' | '), r0.customer_name, MATCH_MK[r0.group?.names_agree] ?? '', STATUS_MK[r0.status], r0.crm ? 'да' : 'не']);
  }
  add('Дупликати', dp, [15, 11, 25, 60, 30, 12, 24, 12]);

  // Постоечки во CRM — only the ones worth a look (name or city disagrees); the full list is in customers-clean.json
  const exi = [['Шифра', 'Име (collabBox)', 'Телефон во CRM', 'Име во CRM', 'Име', 'Град (collabBox)', 'Град во CRM', 'Извор на градот во CRM', 'Град', 'Нарачки во CRM', 'Платени', 'Во Trash (погр. лице/број)', 'collabBox нарачки веќе во CRM', 'Прва', 'Последна', 'Ознаки']];
  for (const r of rows.filter((x) => x.status === 'merge_existing' && (x.crm.name_match === 'different' || x.crm.city_match === 'different'))) {
    exi.push([r.komitent_id, r.name, r.crm.phone, r.crm.name, MATCH_MK[r.crm.name_match], r.city, r.crm.city, r.crm.city_source === 'trusted' ? 'MEX / рачна / collabBox' : r.crm.city_source === 'altercpa_form' ? 'AlterCPA формулар' : '', MATCH_MK[r.crm.city_match], r.crm.orders, r.crm.paid, r.crm.trashed_wrong_person_or_number, r.crm.collabbox_orders, r.crm.first_at, r.crm.last_at, flagsOf(r)]);
  }
  add('Постоечки — несогласувања', exi, [9, 28, 15, 28, 10, 16, 16, 18, 10, 10, 9, 12, 12, 11, 11, 50]);

  // Прескокнати
  const sk = [['Шифра', 'Причина', 'Сите причини', 'Име (како што е внесено)', 'Броеви', 'Одбиени броеви', 'Град', 'Белешки', 'Документи', 'Износ (ден.)', 'Прв', 'Последен', 'Во CRM', 'Нарачки во CRM']];
  for (const r of skip) sk.push([r.komitent_id, REASON_MK[r.reason] ?? r.reason, r.reasons.join(', '), r.name_raw, r.phones.join('; '), rejectsOf(r), r.city, notesOf(r), r.docs.valued, r.docs.value_mkd, r.docs.first, r.docs.last, r.crm ? 'да' : 'не', r.crm?.orders ?? '']);
  add('Прескокнати', sk, [9, 40, 30, 45, 28, 35, 15, 50, 10, 12, 11, 11, 8, 10]);


  // Правила
  const rules = [
    ['Правила (каков купувач влегува во CRM)'],
    ['Телефон', 'Само македонски број: 8 цифри по 0 — мобилен 07X, Скопје 02, 031–034, 042–048. Се прифаќа со/без +389, 00389, 389, празни места, цртички, коси црти. Сè друго се одбива и се запишува — никогаш не се „поправа“ во лажен +389 број.'],
    ['Телефон', 'Лажни броеви се одбиваат: нули (070000000), исти цифри, шема (070707070), редослед (070123456). Броеви како 070333333 се вистински — прифатени, означени.'],
    ['Телефон', 'Извори по ред: Мобилен, Телефон, Факс, Лице за контакт, Име (операторите пишувале број во името), Адреса. Мобилниот е прв. Бројот за нарачката е првиот што CRM веќе го знае, инаку првиот мобилен.'],
    ['Вработени', '„Вработен = Да“ на стариот регистар (Шифра < 40.000) е застарена ознака: 30.125 од 33.708 записи се „Да“, 426 од нив се долгогодишни купувачи — се внесуваат. Вработен е: „Да“ на новиот регистар, „вработен/а“ или „ОПЕРАТОР“ во името, или сметка на оператор (името е исто со авторот на ≥ 2 и ≥ половина од нејзините документи).'],
    ['Фирми', 'Правна форма (ДООЕЛ, ДОО, ДПТУ, АД, ТП, ЈЗУ, ПЗУ, ПУСЗ…), установа (аптека, фармација, хотел, дом за стари, автосервис…) — освен „во продавница“ (белешка за поени), или даночен број / жиро сметка. Текст во „Даночен број“ („НЕ ЈА БАРАЈТЕ“) е белешка, не даночен број.'],
    ['Белешки', 'Од името, Ime_lat, Лице за контакт, Даночен број, Факс: починат, да не се контактира (и деменција, револтиран, службен број), погрешен број, да не се праќа → прескокни. „Не ѕвони од 14–17 ч“ е белешка за време, не забрана. „Враќа нарачки“ → се внесува, означено. Забрана запишана кај еден коминтент важи за сите на истиот телефон (освен „погрешен број“).'],
    ['Име', 'Името е само лицето: HTML знаци декодирани, телефоните и белешките тргнати во „Белешки“, поправени: цифра во зборот, Caps Lock, латинични букви во кирилица, споени зборови. Оригиналот е зачуван.'],
    ['Дупликати', 'Коминтенти со ист телефон (последни 8 цифри) = еден купувач. Името на профилот е најцелосното и најновото; сите шифри се запишани.'],
    ['CRM', 'Споредба по последни 8 цифри со нарачките и профилите во CRM. Постоечки → се спојува и се користи точниот запис на бројот од CRM. Градот од AlterCPA формуларот (60 % „Skopje“) не се смета за вистински.'],
    [],
    ['Изворни датотеки', ''],
    ...meta.sources.map((s) => [s.path, `sha256 ${s.sha256.slice(0, 16)}… · ${s.rows} редови`]),
  ];
  add('Правила', rules, [18, 160]);
  XLSX.writeFile(wb, path, { compression: true, bookSST: true });
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const komPath = args.komitenti || DEFAULT_KOMITENTI;
  const ordersDir = args['orders-dir'] || DEFAULT_ORDERS_DIR;
  const sources = [];
  const load = (p) => { const buf = readFileSync(p); const rows = csvObjects(buf.toString('utf8')); sources.push({ path: p, sha256: sha(buf), rows: rows.length }); return rows; };
  console.log('reading sources …');
  const komitenti = load(komPath);
  const docs = [];
  for (const t of ['10036', '10050']) for (const r of load(join(ordersDir, `type_${t}.csv`))) docs.push(r);
  console.log(`  komitenti ${komitenti.length} · teleshop document headers ${docs.length}`);

  let db;
  if (args['db-cache'] && existsSync(args['db-cache'])) {
    db = JSON.parse(readFileSync(args['db-cache'], 'utf8'));
    console.log(`  CRM read reused from ${args['db-cache']} (${db.read_at})`);
  } else {
    console.log('reading the CRM (read-only) …');
    db = await readDb();
    if (args['db-cache']) writeFileSync(args['db-cache'], JSON.stringify(db));
  }
  console.log(`  CRM: ${db.crm.length} phones · ${db.profiles.length} profiles · ${db.excluded.length} test phones · ${db.settlements.length} settlements`);

  const { rows, stats } = buildTeleshopCustomers({ komitenti, docs, crm: db.crm, profiles: db.profiles, excludedPhone8s: db.excluded, settlements: db.settlements });
  const meta = { rules: RULES_VERSION, generated_at: new Date().toISOString(), db_read_at: db.read_at, sources };

  mkdirSync(OUT_DIR, { recursive: true });
  const jsonPath = join(OUT_DIR, 'customers-clean.json');
  // one komitent per line: diffable, greppable, and a third of the pretty-printed size
  // null / empty fields are left out (absent = null / none); status, reason, reasons, flags, phones always present
  const KEEP = new Set(['status', 'reason', 'reasons', 'flags', 'phones', 'name', 'phone8', 'customer_phone']);
  const compact = (r) => JSON.stringify(r, function (k, v) {
    if (this === r && KEEP.has(k)) return v;
    if (v === null || v === '' || (Array.isArray(v) && !v.length)) return undefined;
    if (this === r && k === 'group' && v.size === 1) return undefined;
    return v;
  });
  const head = JSON.stringify({ ...meta, stats }, null, 1).replace(/\n}$/, '');
  writeFileSync(jsonPath, `${head},\n "customers": [\n${rows.map(compact).join(',\n')}\n ]\n}\n`);
  const xlsxPath = join(OUT_DIR, 'customers-report.xlsx');
  writeReport(xlsxPath, rows, stats, meta);
  console.log(`\nwrote ${jsonPath}\nwrote ${xlsxPath}`);
  console.log(JSON.stringify({ komitenti: stats.komitenti, with_valid_phone: stats.with_valid_phone, by_status: stats.by_status, customers: stats.customers }, null, 1));
}

main().catch((e) => { console.error(scrub(e?.stack || e)); process.exit(1); });
