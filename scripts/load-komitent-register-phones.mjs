/**
 * Load the MISSING komitent phones from a collabBox register harvest into public.collabbox_customers
 * (owner, Mile, 03.10.2026: "Зошто сите 166 иљади … нели треба да внесеме само тоа што недостасува?").
 * No shebang (repair-kit convention). Run with `node`. 🛑 Macedonia only (repair-kit guards).
 *
 * WHY: since 20260947001850 the cohort (insights_sale_rows' bk0 → the TV board, Табла, Операции) counts a
 * 10111 LEADS booking on its booking day only when the customer's phone is known — from the komitent card
 * (source 'card'), the teleshop registry, or any stored row of collabbox_customers. The sync's card lookup
 * found nothing from 29.09 to 03.10 (fixed the same night), so 109 of 165 LEADS documents of 02.10 had no
 * phone. The 01.10 register harvest has them.
 *
 * WHAT: only the komitenti that appear on our collabbox_documents of the sales types (10111 · 10114 · 10036 ·
 * 10050 · 10106 · 10055) and that NO reader can place today (no 8-digit phone on a card, in
 * teleshop_import_customers, or on any collabbox_customers row; no collabbox_customers row at all — a row is
 * never overwritten). From the register only a valid Macedonian phone (registerCard = the sync's
 * komitentCard: Мобилен first, strict NSN, a foreign / invalid number stays NULL — nothing is invented), never
 * a komitent the card verdict skips (employee, company, deceased, test, wrong number), never a test phone.
 * Rows: source 'register_YYYYMMDD' (the harvest's day — 20260947001950 allows it), run_id = this load's
 * data_repair_runs id, skip_reason NULL, flags as the card's (do_not_contact / returns_orders), name + city.
 * Not a card: the writer ignores such a row, a card read later replaces it.
 *
 *   node scripts/load-komitent-register-phones.mjs [--register <komitenti_full.csv>] [--register-date 2026-10-01]
 *        [--out-dir <dir>]
 *        DRY RUN (default, read-only): the counts (komitenti, documents that get a phone by type and month, the
 *        open 10111 documents by sale day, what the documents from the harvest day on still lack), a CSV of the
 *        planned rows in <out-dir> (PII — default exports/phones, gitignored), a data_repair_runs dry-run row
 *        (key collabbox-register-phones, candidate_hash = sha256 of "komitent:phone" lines) and its run id.
 *   node scripts/load-komitent-register-phones.mjs --apply --run <id> --actor mile@elyon.com [same flags]
 *        re-plans, refuses unless the plan hashes to that dry run's, refuses while a collabbox-sync run is
 *        running or outside the quiet window (20:55–07:00 Skopje; --outside-quiet-window overrides); then ONE
 *        transaction: INSERT … ON CONFLICT (komitent_id) DO NOTHING (each row re-checked: still no 8-digit phone
 *        in the teleshop registry), the run marked applied, one audit_log row.
 *   node scripts/load-komitent-register-phones.mjs --rollback <id> [--apply --actor mile@elyon.com]
 *        DELETE FROM collabbox_customers WHERE source = <the run's source> AND run_id = <id> — a row a real
 *        card has replaced since carries source 'card' and stays. Dry by default (counts only).
 */
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  ROOT, bold, die, ok, warn, mkGuard, sql, sqlRead, assertRemoteIsMk, requireQuietWindow, q, qUuid, qJson, parseArgs,
  isUuid, fileStamp, candidateHash, resolveActor, recordDryRun, canonicalJson, fmtSkopje,
} from './lib/repair-kit.mjs';
import { loadRegister, registerCard, registerSource, noPhoneWhy, SOURCE_RE } from './lib/komitent-register.mjs';

export const KEY = 'collabbox-register-phones';
export const SALES_TYPES = Object.freeze(['10111', '10114', '10036', '10050', '10106', '10055']);
const P8 = "'^[0-9]{8}$'";   // insights_sale_rows' bk0 test of a stored phone

/** Every sales document with what the readers know of its customer today (read-only). */
export const docsSql = () => `
select d.doc_number as dn, d.doc_type_id as t, d.komitent_id as k,
       to_char(public.collabbox_sale_at(d.doc_at, d.booked_at) at time zone 'Europe/Skopje', 'YYYY-MM-DD') as sd,
       d.outcome as o,
       (coalesce(d.is_storno, false) or d.reversed_by is not null or d.vanished_at is not null or coalesce(d.amount_mkd, 0) <= 0) as dead,
       exists (select 1 from public.collabbox_customers c where c.komitent_id = d.komitent_id and c.source = 'card' and c.phone8 ~ ${P8}) as c1,
       exists (select 1 from public.teleshop_import_customers t where t.komitent_id = d.komitent_id and t.phone8 ~ ${P8}) as c2,
       exists (select 1 from public.collabbox_customers c where c.komitent_id = d.komitent_id and c.phone8 ~ ${P8}) as c3,
       exists (select 1 from public.collabbox_customers c where c.komitent_id = d.komitent_id) as cc_row
  from public.collabbox_documents d
 where d.doc_type_id in (${SALES_TYPES.map(q).join(', ')}) and d.komitent_id is not null`;

/** The plan: which komitenti get which register row, and the counts. Pure (testable). */
export function plan({ docs, register, testPhones }) {
  const known = (d) => d.c1 || d.c2 || d.c3;
  const byKom = new Map();
  for (const d of docs) if (!known(d)) (byKom.get(d.k) ?? byKom.set(d.k, []).get(d.k)).push(d);
  const verdict = new Map();
  const verdicts = {};
  for (const [k, ds] of byKom) {
    let v; let card = null;
    const r = register.get(k);
    if (ds.some((d) => d.cc_row)) v = 'has_row_without_phone';
    else if (!r) v = 'not_in_register';
    else {
      card = registerCard(r);
      if (card.skip_reason) v = `skip_${card.skip_reason}`;
      else if (!card.phone8) v = `no_valid_phone_${noPhoneWhy(r)}`;
      else if (testPhones.has(card.phone8)) v = 'test_phone';
      else v = 'load';
    }
    verdict.set(k, v === 'load' ? { v, card } : { v });
    verdicts[v] = (verdicts[v] ?? 0) + 1;
  }
  const rows = [...verdict.values()].filter((x) => x.v === 'load').map((x) => x.card)
    .sort((a, b) => Number(a.komitent_id) - Number(b.komitent_id));
  const gets = (d) => !known(d) && verdict.get(d.k)?.v === 'load';
  const docsByType = {}; const docsByMonth = {}; const typeMonth = {};
  let docsGet = 0; let liveGet = 0;
  for (const d of docs) {
    if (!gets(d)) continue;
    docsGet++; if (!d.dead) liveGet++;
    const m = d.sd.slice(0, 7);
    docsByType[d.t] = (docsByType[d.t] ?? 0) + 1;
    docsByMonth[m] = (docsByMonth[m] ?? 0) + 1;
    (typeMonth[d.t] ??= {})[m] = (typeMonth[d.t][m] ?? 0) + 1;
  }
  return {
    rows, verdicts, docsGet, liveGet, docsByType, docsByMonth, typeMonth,
    docsTotal: docs.length, docsWithoutPhone: docs.filter((d) => !known(d)).length, komitentiWithoutPhone: byKom.size,
    open10111: (since) => {
      const o = {};
      for (const d of docs) {
        if (d.t !== '10111' || !['credit_pending', 'booked'].includes(d.o) || d.dead || d.sd < since) continue;
        const a = (o[d.sd] ??= { open: 0, phone_now: 0, phone_after: 0 });
        a.open++; if (known(d)) a.phone_now++; if (known(d) || gets(d)) a.phone_after++;
      }
      return o;
    },
    stillMissing: (since) => {
      const o = {};
      for (const d of docs) {
        if (d.sd < since || known(d) || gets(d)) continue;
        const key = `${d.t} · ${verdict.get(d.k)?.v ?? '?'}`;
        o[key] = (o[key] ?? 0) + 1;
      }
      return o;
    },
  };
}
export const planLines = (rows) => rows.map((r) => `${r.komitent_id}:${r.phone8}`);

/** The ONE-transaction insert (the Management API runs a multi-statement query as one transaction). */
export function applySql({ rows, source, runId, actor, summary }) {
  if (!SOURCE_RE.test(source)) throw new Error(`bad source ${source}`);
  const payload = rows.map((r) => ({ komitent_id: r.komitent_id, object_id: r.object_id, name: r.name, phone8: r.phone8,
    phone_field: r.phone_field, city: r.city, flags: r.flags }));
  return `
insert into public.collabbox_customers as c
       (komitent_id, object_id, name, phone8, phone_field, city, skip_reason, flags, source, run_id, first_seen_at, updated_at)
select x.komitent_id, x.object_id, left(x.name, 200), public.collabbox_mk_phone8(x.phone8), x.phone_field, left(x.city, 120),
       null, coalesce(x.flags, '{}'::text[]), ${q(source)}, ${qUuid(runId)}, now(), now()
  from jsonb_to_recordset(${qJson(payload)})
       as x(komitent_id text, object_id text, name text, phone8 text, phone_field text, city text, flags text[])
 where x.komitent_id ~ '^[0-9]{1,10}$'
   and public.collabbox_mk_phone8(x.phone8) is not null
   and not exists (select 1 from public.teleshop_import_customers t where t.komitent_id = x.komitent_id and t.phone8 ~ ${P8})
on conflict (komitent_id) do nothing;
update public.data_repair_runs
   set applied_at = now(), applied_by = ${qUuid(actor.id)},
       summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', jsonb_build_object(
         'source', ${q(source)}, 'planned', ${rows.length},
         'inserted', (select count(*) from public.collabbox_customers where source = ${q(source)} and run_id = ${qUuid(runId)})))
 where id = ${qUuid(runId)} and applied_at is null;
insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(runId)}, ${q(KEY)},
        ${qJson({ ...summary, source })} || jsonb_build_object('inserted',
          (select count(*) from public.collabbox_customers where source = ${q(source)} and run_id = ${qUuid(runId)})));
select (select count(*) from public.collabbox_customers where source = ${q(source)} and run_id = ${qUuid(runId)})::int as inserted;`;
}

const fmt = (n) => Number(n).toLocaleString('de-DE');
function printPlan(p, { harvestDay }) {
  console.log(bold('\nDocuments'), `${fmt(p.docsTotal)} sales documents; ${fmt(p.docsWithoutPhone)} have no phone today ` +
    `(${fmt(p.komitentiWithoutPhone)} komitenti)`);
  console.log(bold('Komitent verdicts'), p.verdicts);
  console.log(bold('To load'), `${fmt(p.rows.length)} komitenti — mobile column ${p.rows.filter((r) => r.phone_field === 'mobilen').length}, ` +
    `phone column ${p.rows.filter((r) => r.phone_field === 'telefon').length}; do_not_contact flagged ` +
    `${p.rows.filter((r) => r.flags.includes('do_not_contact')).length}`);
  console.log(bold('Documents that get a phone'), `${fmt(p.docsGet)} (not storno / vanished / zero: ${fmt(p.liveGet)})`);
  const months = Object.keys(p.docsByMonth).sort();
  console.log('  type  ' + months.map((m) => m.slice(2).padStart(7)).join('') + '    total');
  for (const t of Object.keys(p.typeMonth).sort()) {
    console.log(`  ${t} ` + months.map((m) => String(p.typeMonth[t][m] ?? '').padStart(7)).join('') + String(p.docsByType[t]).padStart(9));
  }
  console.log('  all   ' + months.map((m) => String(p.docsByMonth[m]).padStart(7)).join('') + String(p.docsGet).padStart(9));
  console.log(bold('Open 10111 LEADS (credit_pending / booked) by sale day — open · with a phone now · after the load'));
  for (const [d, v] of Object.entries(p.open10111('2026-09-20')).sort()) console.log(`  ${d}  ${v.open}  ${v.phone_now}  ${v.phone_after}`);
  console.log(bold(`Documents from ${harvestDay} on that still lack a phone after the load (type · why)`), p.stillMissing(harvestDay));
  console.log('  (new customers after the harvest are not in it — the sync\'s card lookup brings them)');
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'outside-quiet-window'],
    values: ['run', 'actor', 'register', 'register-date', 'out-dir', 'rollback'],
  });
  mkGuard();
  await assertRemoteIsMk();
  const harvestDay = args['register-date'] ?? '2026-10-01';
  const source = registerSource(harvestDay);

  if (args.rollback) {
    const runId = args.rollback;
    if (!isUuid(runId)) die('--rollback must be the data_repair_runs id of the load.');
    const [run] = await sqlRead(`select id, key, summary, applied_at from public.data_repair_runs where id = ${qUuid(runId)}`);
    if (!run || run.key !== KEY) die(`run ${runId} is not a ${KEY} run.`);
    const src = run.summary?.apply?.source ?? run.summary?.options?.source ?? source;
    if (!SOURCE_RE.test(src)) die(`run ${runId}: unexpected source ${src}`);
    const [c] = await sqlRead(`select count(*)::int as n, count(*) filter (where phone8 is not null)::int as with_phone
      from public.collabbox_customers where source = ${q(src)} and run_id = ${qUuid(runId)}`);
    console.log(`run ${runId} (${src}): ${c.n} rows still carry it (a card read since replaced the others).`);
    if (!args.apply) { console.log('Dry run — add --apply --actor <email> to delete them.'); return; }
    if (!args.actor) die('--actor <email> is required with --apply.');
    const actor = await resolveActor(args.actor);
    const [r] = await sql(`with del as (delete from public.collabbox_customers where source = ${q(src)} and run_id = ${qUuid(runId)} returning 1)
      , a as (insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
              values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.rollback', 'data_repair_run', ${q(runId)}, ${q(KEY)},
                      jsonb_build_object('source', ${q(src)}, 'deleted', (select count(*) from del))) returning 1)
      select (select count(*) from del)::int as deleted`);
    ok(`rolled back: ${r.deleted} rows deleted (source ${src}, run ${runId}).`);
    return;
  }

  const registerFile = args.register ?? join(ROOT, 'exports', 'collabbox', `collab-out-${harvestDay}`, 'komitenti_full.csv');
  const register = loadRegister(registerFile);
  ok(`register ${registerFile}: ${fmt(register.size)} komitenti`);
  const [tp] = await sqlRead('select public.report_excluded_phone8s() as p');
  const testPhones = new Set(tp?.p ?? []);
  const docs = await sqlRead(docsSql());
  const p = plan({ docs, register, testPhones });
  printPlan(p, { harvestDay });
  const lines = planLines(p.rows);
  const options = { source, register: registerFile.replace(/\\/g, '/').split('/').slice(-2).join('/') };
  const summary = { options, komitenti: p.rows.length, documents: p.docsGet, live_documents: p.liveGet, verdicts: p.verdicts,
    by_type: p.docsByType, by_month: p.docsByMonth };

  if (!args.apply) {
    const dir = args['out-dir'] ?? join(ROOT, 'exports', 'phones');
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${KEY}-${fileStamp()}.csv`);
    writeFileSync(file, '﻿komitent_id,phone8,phone_field,flags\n' + p.rows.map((r) => `${r.komitent_id},${r.phone8},${r.phone_field},${r.flags.join('|')}`).join('\n') + '\n');
    const { id, hash } = await recordDryRun({ key: KEY, lines, summary });
    console.log(`\nCSV (PII): ${file}\nDry run recorded: ${bold(id)} (hash ${hash.slice(0, 12)}…)`);
    console.log(`Apply: node scripts/load-komitent-register-phones.mjs --apply --run ${id} --actor <email>`);
    return;
  }

  // ── apply ──
  if (!args.run || !isUuid(args.run)) die('--run <dry-run id> is required with --apply.');
  if (!args.actor) die('--actor <email> is required with --apply.');
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  const [run] = await sqlRead(`select id, key, dry_run, candidate_hash, summary, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
  if (!run || run.key !== KEY) die(`run ${args.run} is not a ${KEY} dry run.`);
  if (run.applied_at) die(`run ${args.run} was already applied at ${fmtSkopje(run.applied_at)}.`);
  if (canonicalJson(run.summary?.options ?? {}) !== canonicalJson(options)) die('the dry run used other options — pass the same flags.');
  const hash = candidateHash(lines);
  if (hash !== run.candidate_hash) die(`the plan changed since the dry run (hash ${hash.slice(0, 12)}… ≠ ${String(run.candidate_hash).slice(0, 12)}…) — dry-run again.`);
  ok(`plan hashes to the dry run (${hash.slice(0, 12)}…)`);
  const busy = await sqlRead(`select id from public.collabbox_sync_runs where status = 'running' and kind in ('nightly', 'manual')
                                and started_at > now() - interval '20 minutes'`);
  if (busy.length) die('a collabbox-sync run is running — try again when it has finished.');
  const actor = await resolveActor(args.actor);
  const res = await sql(applySql({ rows: p.rows, source, runId: args.run, actor, summary }));
  const inserted = res?.[0]?.inserted;
  ok(`applied: ${inserted} of ${p.rows.length} planned rows inserted (source ${source}, run ${args.run}).`);
  if (inserted !== p.rows.length) warn('fewer than planned — a card or a parcel row arrived for the rest since the plan (never overwritten).');
  console.log(`Rollback: node scripts/load-komitent-register-phones.mjs --rollback ${args.run} --apply --actor ${actor.email}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e?.stack || String(e)));
}
