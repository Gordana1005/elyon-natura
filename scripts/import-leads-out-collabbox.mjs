/**
 * Import — LEADS-OUT (collabBox type 10114, series 9103, BIO NATURAL) sales that our CRM agents
 * booked ONLY in collabBox: the MEX parcel exists, no CRM order does. No shebang (repair-kit
 * convention). Run with `node`.
 *
 * OWNER (28.09.2026): LEADS-OUT booked only in collabBox by an agent who works in our CRM is an
 * ElyonCRM prediction sale credited to her — "from the day she started working in the CRM" — and
 * the same order must never count twice. Found the same day: ~130 such parcels in September
 * (≈300.000 ден delivered) stood in the Overview as "Elyon account — unlinked", credited to nobody;
 * 39 of them after the agent had logged the customer as a 0 ден "no sale" in the CRM.
 *
 * A document becomes an order only when ALL hold:
 *   - its header + lines are in the --fetch file (scripts/collabbox-fetch.mjs --types 10114 --items xls);
 *   - public.collabbox_department(type, DocNumber, author, doc time) gives its department: 10114 is
 *     Affiliate – Lead out (elyon_crm / collabbox_leads_out). [The 28.09 "AlterCPA team →
 *     team_collabbox_leads_out" rule was WITHDRAWN by 20260942001100 — a team never decides a
 *     department; this header described it, the live function does not.]
 *   - its MEX parcel (tracking id = DocNumber) is in the register, COD > 0, linked to no order and
 *     named by none, and no order already carries the DocNumber;
 *   - no live sale on the same last-8 phone, holding no parcel, created from 3 days before to 1 day
 *     after the parcel, has a price that fits the COD (that would be the same sale → listed, never
 *     created).
 * The order: source_type import / external_source collabbox / external_order_id = DocNumber, so the
 * insert trigger gives it that department; seller only in sold_* (sold_via
 * collabbox); status from MEX (delivered → paid with the MEX time and basis mex, returned →
 * returned, anything else → shipped); price = the document amount when the COD equals it (or it
 * + 150 delivery), else the COD (MEX is right); lines from the document (product via
 * product_aliases), scaled to the price. Nothing is written to collabBox or AlterCPA.
 *
 *   node scripts/import-leads-out-collabbox.mjs --fetch <collabbox_….json>                # dry run → CSV + run id
 *   node scripts/import-leads-out-collabbox.mjs --fetch <…> --apply --run <id> [--actor mile@elyon.com] [--outside-quiet-window]
 *   node scripts/import-leads-out-collabbox.mjs --rollback --run <id> [--apply]           # delete what that run created
 *
 * 🛑 Macedonia only (repair-kit guards). Payout / bonus math untouched.
 */
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  MK_REF, MKD_PER_EUR, bold, green, yellow, die, ok, warn,
  mkGuard, sql, sqlRead, assertRemoteIsMk, q, qUuid, qTextArray,
  phone8, fmtMkd, fmtSkopje, fileStamp, writeCsv, planLine, printTable, tally,
  resolveActor, recordDryRun, verifyRunForApply, finalizeRun,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute, parseArgs,
} from './lib/repair-kit.mjs';

export const KEY = 'leads-out-import';
const LEADS_OUT = '10114';
const NON_PRODUCT = new Set(['loyalty_point', 'delivery', 'note', 'flyer']);
const fitsMkd = (a, cod) => a > 0 && (Math.abs(cod - a) <= 3 || Math.abs(cod - a - 150) <= 3);
const round2 = (x) => Math.round(x * 100) / 100;

export function readFetch(path) {
  const j = JSON.parse(readFileSync(path, 'utf8'));
  const headers = (j.headers || []).filter((h) => String(h.typeId) === LEADS_OUT);
  const lines = new Map();
  for (const it of j.items || []) {
    if (!it.docNumber) continue;
    (lines.get(it.docNumber) ?? lines.set(it.docNumber, []).get(it.docNumber)).push(it);
  }
  return { headers, lines };
}

async function loadDb(headers) {
  if (!headers.length) return [];
  const vals = headers.map((h) => `(${q(h.docNumber)}, ${q(h.author || null)}, ${q(h.datetime ? `${h.datetime}` : null)})`).join(',\n');
  return sqlRead(`
    with d(doc, author, at_local) as (values ${vals}),
    dd as (select doc, author, (at_local::timestamp at time zone 'Europe/Skopje') as at from d)
    select dd.doc, dd.author, dd.at,
           p.tracking_id, p.status_id, p.status_name, p.cod_mkd, p.phone8, p.receiver_name, p.receiver_city,
           p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at, p.order_id as p_order,
           (select count(*) from public.orders n where n.mex_tracking_id = dd.doc)::int as namers,
           exists (select 1 from public.orders o where o.external_source = 'collabbox' and o.external_order_id = dd.doc) as imported,
           pers.id as person_id, pers.display_name as person,
           (public.collabbox_department(dd.doc, pers.id, dd.at))[2] as detail,
           (select coalesce(jsonb_agg(o.display_id), '[]'::jsonb) from public.orders o
             where p.phone8 is not null
               and right(regexp_replace(o.customer_phone, '[^0-9]', '', 'g'), 8) = p.phone8
               and o.mex_tracking_id is null and o.price > 0
               and o.status::text in ('pending', 'call_again', 'confirmed', 'shipped', 'paid', 'returned', 'delivered')
               and coalesce(o.sale_source_detail, '') <> 'disposition'
               and o.created_at between p.created_at_mex - interval '3 days' and p.created_at_mex + interval '1 day'
               and (abs(round(o.price * 61.5) - p.cod_mkd) <= 3 or abs(round(o.price * 61.5) + 150 - p.cod_mkd) <= 3)) as twins
      from dd
      left join public.mex_parcels p on p.tracking_id = dd.doc
      left join lateral (select sp.id, sp.display_name from public.sales_person_identities i
                           join public.sales_people sp on sp.id = i.person_id
                          where i.kind = 'collabbox_author' and dd.author is not null
                            and regexp_replace(btrim(i.value), '\\s+', ' ', 'g') = regexp_replace(btrim(dd.author), '\\s+', ' ', 'g')
                          order by i.created_at limit 1) pers on true`);
}

async function loadProducts(names) {
  const list = [...new Set(names.filter(Boolean))];
  if (!list.length) return new Map();
  const rows = await sqlRead(`
    select a.name,
           (select pa.product_id from public.product_aliases pa where pa.alias_norm = public.product_alias_norm(a.name)
             and pa.source in ('collabbox', 'any') order by (pa.source = 'collabbox') desc limit 1) as alias_pid,
           (select pa.kind from public.product_aliases pa where pa.alias_norm = public.product_alias_norm(a.name)
             and pa.source in ('collabbox', 'any') order by (pa.source = 'collabbox') desc limit 1) as alias_kind,
           (select p.id from public.products p where public.product_alias_norm(p.name) = public.product_alias_norm(a.name) limit 1) as name_pid
      from unnest(${qTextArray(list)}) a(name)`);
  const names2 = await sqlRead(`select id, name from public.products`);
  const pname = new Map(names2.map((r) => [r.id, r.name]));
  return new Map(rows.map((r) => { const id = r.alias_pid || r.name_pid || null; return [r.name, { id, kind: r.alias_kind || (id ? 'product' : null), name: id ? pname.get(id) : null }]; }));
}

export function plan({ headers, lines, db, products, runTag = 'dry-run' }) {
  const hdr = new Map(headers.map((h) => [h.docNumber, h]));
  const out = [], csv = [], planLines = [];
  const counts = { documents: db.length, create: 0, not_crm: 0, no_parcel: 0, linked_or_named: 0, imported: 0, twin: 0, no_phone: 0, cod0: 0, no_lines: 0 };
  for (const r of db) {
    const h = hdr.get(r.doc);
    const ls = (lines.get(r.doc) || []);
    let why = '';
    if (!r.detail) { why = 'not a lead-out document'; counts.not_crm++; }
    else if (!r.tracking_id) { why = 'parcel not in the MEX register'; counts.no_parcel++; }
    else if (r.imported) { why = 'already an order'; counts.imported++; }
    else if (r.p_order || r.namers) { why = 'parcel already held / named by an order'; counts.linked_or_named++; }
    else if (!(Number(r.cod_mkd) > 0)) { why = 'COD 0 (a replacement)'; counts.cod0++; }
    else if (!/^[0-9]{8}$/.test(String(r.phone8 || ''))) { why = 'no phone at MEX'; counts.no_phone++; }
    else if (Array.isArray(r.twins) && r.twins.length) { why = `same sale may be ${r.twins.join(', ')} (price fits the COD) — listed`; counts.twin++; }
    const items = ls.map((l) => ({ l, p: products.get(String(l.article || '').trim()) || { id: null, kind: null, name: null } }))
      .filter((x) => !NON_PRODUCT.has(x.p.kind));
    if (!why && !items.length) { why = 'no product lines'; counts.no_lines++; }
    const cod = Number(r.cod_mkd);
    const amount = Number(h?.amount || 0);
    const priceMkd = !why ? (fitsMkd(amount, cod) ? amount : cod) : null;
    const status = Number(r.status_id) === 2 ? 'paid' : Number(r.status_id) === 7 ? 'returned' : 'shipped';
    csv.push({ doc: r.doc, doc_at: fmtSkopje(r.at), author: r.author || '', person: r.person || '', parcel: `${r.status_id ?? ''} ${r.status_name || ''}`.trim(),
      cod_mkd: r.cod_mkd ?? '', amount_mkd: amount || '', price_mkd: priceMkd ?? '', status: why ? '' : status, lines: ls.length, action: why ? 'skip' : 'create', why });
    if (why) continue;
    counts.create++;
    const priceEur = round2(priceMkd / MKD_PER_EUR);
    // lines scaled to the price, cents on the largest
    const vals = items.map((x) => Math.max(0, Number(x.l.saleValueVat) || 0));
    const sum = vals.reduce((a, b) => a + b, 0);
    const totals = items.map((x, i) => (sum > 0 ? round2(priceEur * vals[i] / sum) : (i === 0 ? priceEur : 0)));
    const diff = round2(priceEur - totals.reduce((a, b) => a + b, 0));
    const big = totals.indexOf(Math.max(...totals));
    totals[big] = round2(totals[big] + diff);
    const its = items.map((x, i) => {
      const qty = Math.max(1, Math.round(Number(x.l.qtyOut) || 1));
      return { product_id: x.p.id, name: x.p.name || String(x.l.article || '').trim() || '—', qty, total: totals[i], ppu: round2(totals[i] / qty) };
    });
    const main = its[big];
    const p = { doc: r.doc, at: r.at, author: r.author, person_id: r.person_id, phone: `+389${r.phone8}`, name: r.receiver_name || h?.customerName || '—',
      city: r.receiver_city || '', price: priceEur, qty: its.reduce((a, b) => a + b.qty, 0), product_id: main.product_id, product_name: main.name,
      status, paid_at: status === 'paid' ? (r.delivered_at || r.last_update_at) : null, returned_at: status === 'returned' ? (r.returned_at || r.last_update_at) : null,
      shipped_at: r.created_at_mex, basis: status === 'paid' ? 'mex' : null, exp_status: r.status_id, exp_cod: r.cod_mkd, items: its };
    out.push(p);
    planLines.push(planLine(r.doc, 'create', `${status}:${priceEur}`, r.doc));
  }
  return { rows: out, csv, lines: planLines, counts };
}

function chunkSql({ runId, rows }) {
  const vals = rows.map((p) => `(${[q(p.doc), q(p.at), q(p.author), qUuid(p.person_id), q(p.phone), q(p.name), q(p.city), `${p.price}::numeric`, `${p.qty}::int`,
    qUuid(p.product_id), q(p.product_name), q(p.status), q(p.paid_at), q(p.returned_at), q(p.shipped_at), q(p.basis), `${Number(p.exp_status)}::int`, `${Number(p.exp_cod)}::int`,
    `${q(JSON.stringify(p.items))}::jsonb`].join(', ')})`).join(',\n');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';
create temp table _p (doc text primary key, at timestamptz, author text, person_id uuid, phone text, name text, city text, price numeric, qty int,
  product_id uuid, product_name text, status text, paid_at timestamptz, returned_at timestamptz, shipped_at timestamptz, basis text,
  exp_status int, exp_cod int, items jsonb) on commit drop;
insert into _p values
${vals};
select count(*) from (select 1 from public.mex_parcels where tracking_id in (select doc from _p) for update) l;
create temp table _ok on commit drop as
select p.* from _p p
 where not exists (select 1 from public.orders o where o.external_source = 'collabbox' and o.external_order_id = p.doc)
   and not exists (select 1 from public.orders o where o.mex_tracking_id = p.doc)
   and exists (select 1 from public.mex_parcels m where m.tracking_id = p.doc and m.order_id is null
                 and m.status_id is not distinct from p.exp_status and m.cod_mkd is not distinct from p.exp_cod);
create temp table _new (id uuid, doc text, sale_source text, detail text, status text, sold_by uuid) on commit drop;
with ins as (
  insert into public.orders (product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
         price, quantity, status, source_type, external_source, external_order_id, delivery_type,
         created_at, confirmed_at, sold_at, sold_via, sold_by_ext, sold_by_person_id,
         mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at)
  select p.product_id, p.product_name, p.name, p.phone, p.city, '', p.price, greatest(p.qty, 1), p.status::public.order_status,
         'import', 'collabbox', p.doc, 'home', p.at, p.at, p.at, 'collabbox', p.author, p.person_id,
         p.doc, p.paid_at, p.basis, p.shipped_at, p.returned_at
    from _ok p order by p.at, p.doc
  on conflict (external_source, external_order_id) where external_order_id is not null do nothing
  returning id, external_order_id, sale_source, sale_source_detail, status::text, sold_by_person_id)
insert into _new select * from ins;
insert into public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
select n.id, nullif(x->>'product_id', '')::uuid, left(coalesce(nullif(x->>'name', ''), '—'), 300),
       greatest((x->>'qty')::int, 1), (x->>'ppu')::numeric, (x->>'total')::numeric, p.at
  from _new n join _ok p on p.doc = n.doc cross join lateral jsonb_array_elements(p.items) x;
create temp table _links on commit drop as
select n.id, n.doc, public.mex_link_parcel(n.doc, n.id, 'collabbox_import', false) as res from _new n order by n.doc;
do $chk$
declare bad text; n int;
begin
  select string_agg(doc || ' → ' || coalesce(res, 'null'), ', ') into bad from _links where res is null or res not in ('linked', 'already');
  if bad is not null then raise exception 'leads-out-import: mex_link_parcel refused: %', bad; end if;
  select count(*), string_agg(x.doc || ' ' || x.status || '/' || p.status || ' ' || coalesce(x.sale_source, '-') || '/' || coalesce(x.detail, '-')
                              || ' sold_by ' || coalesce(x.sold_by::text, '-') || ' vs ' || coalesce(p.person_id::text, '-'), '; ')
    into n, bad
    from _new x join _ok p on p.doc = x.doc
   where x.status <> p.status
      -- the department decides (20260942000700): by the DocNumber series and the author's team that day
      or array[x.sale_source, x.detail] is distinct from public.collabbox_department(x.doc, x.sold_by, p.at)
      or x.sold_by is distinct from p.person_id;
  if n > 0 then raise exception 'leads-out-import: % orders did not land as elyon_crm (collabbox_leads_out / collabbox_out by series) with their status and seller: %', n, bad; end if;
end $chk$;
insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(runId)}, n.id, 'leads-out-import', null, jsonb_build_object('status', n.status, 'sale_source', n.sale_source, 'detail', n.detail),
       jsonb_build_object('doc', n.doc, 'author', p.author, 'price_eur', p.price)
  from _new n join _ok p on p.doc = n.doc;
select (select count(*) from _p)::int as planned, (select count(*) from _new)::int as applied, (select count(*) from _links)::int as links;`;
}

async function rollback(runId, apply) {
  const rows = await sqlRead(`select r.order_id, o.display_id, o.external_order_id from public.data_repair_rows r
    join public.orders o on o.id = r.order_id where r.run_id = ${qUuid(runId)} and r.rule = 'leads-out-import'`);
  console.log(`run ${runId}: ${rows.length} orders created`);
  if (!apply) { console.log(yellow('  dry run — add --apply to delete them (their parcels are unlinked first)')); return; }
  const [r] = await sql(`
    set local elyon.bulk_repair = 'on';
    set local elyon.keep_updated_at = 'on';
    create temp table _d on commit drop as select r.order_id from public.data_repair_rows r where r.run_id = ${qUuid(runId)} and r.rule = 'leads-out-import';
    update public.mex_parcels set order_id = null, link_method = null, linked_at = null where order_id in (select order_id from _d);
    delete from public.order_items where order_id in (select order_id from _d);
    delete from public.orders where id in (select order_id from _d);
    select (select count(*) from _d)::int as deleted;`);
  ok(`rolled back: ${r.deleted} orders deleted`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2), { flags: ['apply', 'rollback', 'outside-quiet-window', 'help'], values: ['run', 'fetch', 'actor'] });
  if (args.help) { console.log('usage: see the header of scripts/import-leads-out-collabbox.mjs'); return; }
  mkGuard();
  await assertRemoteIsMk();
  if (args.rollback) { if (!args.run) die('--rollback needs --run <id>'); await rollback(args.run, !!args.apply); return; }
  const APPLY = !!args.apply;
  console.log(bold(`\nImport — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (!args.fetch) die('--fetch <collabbox_….json> (scripts/collabbox-fetch.mjs --types 10114 --items xls) is required.');
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) { requireQuietWindow({ override: !!args['outside-quiet-window'] }); await requireNoSegmentRecompute('start the import'); }

  const { headers, lines } = readFetch(args.fetch);
  ok(`${headers.length} LEADS-OUT headers, lines for ${lines.size} documents ← ${args.fetch}`);
  const db = await loadDb(headers);
  const products = await loadProducts([...lines.values()].flat().map((l) => String(l.article || '').trim()));
  const p = plan({ headers, lines, db, products, runTag: APPLY ? String(args.run).slice(0, 8) : 'dry-run' });
  printTable(Object.entries(tally(p.csv, (r) => `${r.action} · ${r.action === 'create' ? r.status : r.why}`, (r) => r.cod_mkd))
    .map(([k, v]) => ({ case: k, docs: v.orders, 'COD (ден)': fmtMkd(v.mkd) })));
  printTable(Object.entries(tally(p.csv.filter((r) => r.action === 'create'), (r) => r.person, (r) => r.price_mkd))
    .map(([k, v]) => ({ agent: k, sales: v.orders, 'ден': fmtMkd(v.mkd) })));
  const unmapped = p.rows.flatMap((r) => r.items).filter((i) => !i.product_id).length;
  if (unmapped) warn(`${unmapped} lines have no catalogue product (kept with their collabBox name)`);
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, p.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (!APPLY) {
    const { id, hash } = await recordDryRun({ key: KEY, lines: p.lines, summary: { script: 'import-leads-out-collabbox.mjs', counts: p.counts, fetch: args.fetch, csv: csvPath.split(/[\\/]/).pop() } });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)\n  node scripts/import-leads-out-collabbox.mjs --fetch "${args.fetch}" --apply --run ${id}\n`);
    return;
  }
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  await verifyRunForApply({ key: KEY, runId: args.run, lines: p.lines });
  let applied = 0, links = 0;
  for (let i = 0; i < p.rows.length; i += 100) {
    const [r] = await sql(chunkSql({ runId: args.run, rows: p.rows.slice(i, i + 100) }));
    applied += r.applied; links += r.links;
    console.log(`  chunk ${i / 100 + 1}: ${r.applied}/${r.planned} created, ${r.links} parcels linked`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload: { script: 'import-leads-out-collabbox.mjs', counts: p.counts, applied, links } });
  ok(`run ${args.run} applied — ${applied} ElyonCRM orders created, ${links} parcels linked`);
  console.log(yellow('  Next: node scripts/verify-attribution.mjs, node scripts/engine-fixture-mk.mjs. Undo: --rollback --run <id> --apply\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
