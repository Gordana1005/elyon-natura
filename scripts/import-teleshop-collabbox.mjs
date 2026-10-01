#!/usr/bin/env node
/**
 * TELESHOP IMPORT — the collabBox teleshop customers and their order history → the CRM.
 *
 * Owner (Mile, 28.09.2026): "From 01.09 teleshop must work fully through our CRM … import the
 * teleshop clients — carefully, legitimately, without garbage, everything recorded properly and
 * as accurate as every metric we keep."
 *
 *   node scripts/import-teleshop-collabbox.mjs                       # DRY RUN (read-only): report,
 *                                                                    #   CSVs, the owner's .xlsx
 *   node scripts/import-teleshop-collabbox.mjs --record              # dry run + ONE data_repair_runs
 *                                                                    #   row (run id + hash) to apply
 *   node scripts/import-teleshop-collabbox.mjs --apply --run <id> [--actor mile@elyon.com]
 *                                     [--chunk 500] [--outside-quiet-window]
 *   node scripts/import-teleshop-collabbox.mjs --drain               # settle the deferred segment queue
 *   node scripts/import-teleshop-collabbox.mjs --rollback --run <id> [--apply]
 *
 *   --from / --to YYYY-MM-DD   document window (Skopje days, inclusive; default 2023-01-01 → today)
 *   --fetch a.json[,b.json]    collabbox-fetch.mjs output(s): newer headers (they win over the crawl
 *                              for the same DocNumber) and LINE ITEMS (products) for those documents
 *   --orders-dir / --komitenti the local crawl (default C:\Users\Mile\collab_out\…)
 *   --customers <file>         helper A's customers-clean.json (default exports/teleshop/, used when present)
 *   --items a.json[,b.json]    helper B's items-*-summary.json (default items-2026 + items-2023-2025, used
 *                              when present): real line items (their product_id — never re-mapped here;
 *                              order_items.quantity = physical UNITS) and FRESH 28.09 headers, which win over
 *                              the 10.09 crawl, add every later document and reveal deleted ones
 *   --banned-as-trash          (owner 28.09: ON) import the DO-NOT-CONTACT komitenti with their orders and put
 *                              their phone in sticky Trash: one trashed 'other' disposition row, note
 *                              "Не се јавувај (collabBox)". DECEASED komitenti are never imported.
 *   --trash-banned-existing    (owner 28.09: ON) the same marker for such people already in the CRM —
 *                              do-not-contact "Не се јавувај (collabBox)", deceased
 *                              "Починат/а – не се јавувај (collabBox)". Released only by a manager changing
 *                              the marker order's status (Trash List → its trigger order), or by a later
 *                              PAID order (the MK sticky-trash rule).
 *   --relabel-source           (owner 28.09: ON) existing 'teleshop' orders that are really LEADS-OUT / LEADS
 *                              documents get their real sale_source_detail (+ a note; rollback-able)
 *   --keep-storno-originals    keep the document a storno reverses (default: excluded as reversed_by_storno)
 *   --confirm-awaiting         create MEX-era documents that have no parcel yet as 'confirmed' (default: wait)
 *   --no-cohort / --no-segments  skip the (read-only) metric simulations
 *   --vraboten-literal         skip EVERY komitent with Vraboten = Да (default: only real employees)
 *   --xlsx <path>              the owner's sheet (default exports/teleshop/<day>-teleshop-uvoz-proba.xlsx)
 *
 * SOURCES (read-only)
 *   type_10036.csv / type_10050.csv  the 2026-09-10 header crawl: DocID, DocNumber, TipID, Tip,
 *                                    KomitentID, Komitent, Iznos ("2,000.00"), Valuta, Datum
 *                                    (dd.mm.yyyy HH:MM:SS, Skopje wall clock), Avtor. No products.
 *   the other type_*.csv             only to detect a DocNumber claimed by another type.
 *   komitenti_full.csv               the customer registry (phone, address, Vraboten, tax no.).
 *   MK database                      orders, mex_parcels, web_orders claims, customer_profiles,
 *                                    report_excluded_phones, seller identities, segment members,
 *                                    insights_sale_rows (the cohort) — SELECT only in a dry run.
 *
 * WHAT BECOMES AN ORDER (owner decisions 28.09 — law)
 *   A Нарачка in (10036) / Нарачка out (10050) document of series 9100 / 9102, worth > 0, whose
 *   komitent is a real Macedonian retail customer, that has no order yet — exactly ONE order per
 *   DocNumber (idempotent: external_source 'collabbox' + external_order_id = DocNumber, backed by
 *   uniq_orders_external_ref; sale_source 'collabbox' / detail 'teleshop' come from the trigger).
 *   Never an order: other series inside those types (9103 LEADS-OUT, 9110 LEADS, 9108 social, 9225,
 *   store series), value 0 or parcel COD 0 (replacements), no amount, a DocNumber that is
 *   duplicated or claimed by another type, social / web / LEADS / LEADS-OUT / store types.
 *
 * STATUS — collabBox never decides "paid" in the MEX era:
 *   parcel (mex_parcels.tracking_id = DocNumber)  2 → paid (paid_at = delivered_at, paid_basis
 *     'mex') · 7 → returned · anything else → shipped. Linked with mex_link_parcel(…,
 *     'collabbox_import'), never forced; mex-reconcile keeps it current from then on.
 *   no parcel, document before MEX coverage (Skopje day < 2026-03-30 — from that day 100 % of
 *     teleshop documents have their parcel) → paid, paid_basis 'legacy_import' (the 2026-08-12
 *     operator rule; the cohort shows it as paid_legacy, never as MEX-proven cash).
 *   no parcel, MEX era: ≤ 7 days old → NOT created yet ('awaiting_parcel': 99,99 % of teleshop parcels
 *     register 0–4 days after the document; a later run creates it once MEX has it —
 *     --confirm-awaiting creates it 'confirmed' instead); older → NOT created ('no_parcel_mex_era':
 *     in the MEX era a teleshop sale that ships always has its parcel under its own DocNumber).
 *   A parcel another order holds, a tracking id another order names, a web-claimed parcel, or a CRM
 *   sale on the same phone ±7 days with no parcel whose price fits the amount ("possible twin") →
 *   CONFLICT: nothing is created, the holder is recorded (no double counting, never forced).
 *
 * CUSTOMERS — one per real phone
 *   Phone = the registry's Мобилен, else Телефон, else the parcel receiver's phone — STRICTLY
 *   Macedonian (8 national digits: 7X mobile, 2 Skopje, 3[1-4] / 4[2-8] area codes); anything else
 *   is rejected, never rewritten into a fake +389 number. Matched to the CRM by last-8 digits: the
 *   CRM's canonical E.164 string is reused (the engine keys on the exact string). A MALFORMED CRM
 *   spelling (+38938076222888) is never reused: the new orders get the clean E.164 and are
 *   flagged crm_phone_malformed_twin for a phone repair. Not imported (listed): employees (a current-register komitent
 *   with Vraboten = Да, or "вработен/а" in the name — on the legacy register, Sifra < 40.000,
 *   Да is a stale default on 30.110 rows incl. 426 real repeat buyers; --vraboten-literal skips
 *   every Да), companies /
 *   shops / institutions, names that say deceased / do-not-contact / wrong number / test, the
 *   owner's test phones (report_excluded_phones), komitenti with no valid Macedonian phone.
 *   Names are kept as written (HTML entities decoded, whitespace collapsed). customer_profiles:
 *   inserted for a new phone, only EMPTY fields filled on an existing one.
 *
 * PRODUCTS — the crawl has none. An order without line items is written with product_id NULL and
 *   the one constant product name "collabBox: без ставки (непознат производ)" — never an invented
 *   product; every product / stock / cost metric sees one clearly-labelled unknown bucket (the
 *   same "contents unknown" the cohort already uses for a MEX-only parcel). With --fetch, the
 *   documents it covers get real order_items (SKU map + products.sku); service lines (ДОСТАВА,
 *   ЗАБЕЛЕШКА, ПОЕН-*) are never items.
 *
 * SELLER — written straight into sold_*: sold_at = the document time, sold_via 'collabbox',
 *   sold_by_ext = Aвтор (in the identity's own spelling), sold_by_person_id = the
 *   sales_person_identities person (kind collabbox_author, else order_name). tg_orders_stamp_sold
 *   sees sold_at already set and keeps it (write-once). NO agent-facing identity is written —
 *   confirmed_by_name / confirmed_by_agent_id / assigned_agent_* stay NULL — so 2023–26 teleshop
 *   history never folds onto an agent's Dashboard / My orders / folded stats / unpaid chase
 *   (review 28.09). Insights credits the seller through sold_by_person_id.
 *
 * WRITES (--apply only; quiet window 20:55–07:00 Skopje; never beside recompute_all_segments or
 *   the 7-day rule): ≤ 500 documents per transaction, each under
 *     SET LOCAL elyon.bulk_repair    = 'on'   no paid / returned bells, no confirm-rate trigger
 *     SET LOCAL elyon.keep_updated_at = 'on'  existing rows' updated_at never moves
 *     SET LOCAL elyon.defer_segments  = 'on'  phones QUEUED, not recomputed per row
 *   (migration 20260942000300 adds the queue + the ledger). Then --drain settles the queue once
 *   and node scripts/engine-fixture-mk.mjs proves the engine contract. The dry run's hash covers
 *   every document's planned outcome: any change between the dry run and the apply (a parcel
 *   delivered, an order created) refuses the apply → dry-run again (do both after 21:15 Skopje).
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards; the token can write Bulgaria too). The live shop
 *   naturatherapy.mk is never touched. collabBox is never contacted by this script.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as XLSX from 'xlsx';
import {
  ROOT, bold, green, yellow, red, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  segmentRecomputeActivity, q, qUuid, qJson, qTextArray, isUuid, parseArgs, fmtSkopje, fileStamp, candidateHash,
  resolveActor, canonicalJson,
} from './lib/repair-kit.mjs';
import * as T from './lib/teleshop-import.mjs';

export const KEY = 'teleshop-import';
const ACTOR_NAME = 'System (import:teleshop-collabbox)';
const DEFAULT_ORDERS_DIR = 'C:/Users/Mile/collab_out/99-arhiva-surovo-prevzemanje/orders';
const DEFAULT_KOMITENTI = 'C:/Users/Mile/collab_out/08-komitenti-klienti/komitenti_full.csv';
const OUT_DIR = join(ROOT, 'exports', 'teleshop');
const OTHER_TYPES = ['10106', '10111', '10114', '10112', '10055', '10063', '10058'];
const SALE_STATUSES = new Set(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);
const TWIN_WINDOW_MS = 7 * T.DAY_MS;
const LOOSE_TWIN_MS = 3 * T.DAY_MS;
/** Skip reasons that are a BAN on calling the person (helper A's + the interim markers) → the ban family. */
const BAN_FAMILY = Object.freeze({ deceased: 'deceased', phone_marked_deceased: 'deceased', do_not_contact: 'do_not_contact', phone_marked_do_not_contact: 'do_not_contact' });
// Owner decision 2026-09-28 (evening): the exact notes on the trash marker.
const BAN_NOTE = Object.freeze({ deceased: 'Починат/а – не се јавувај (collabBox)', do_not_contact: 'Не се јавувај (collabBox)' });
/** Which ban families --banned-as-trash IMPORTS (owner: deceased komitenti are never imported — neither customer nor orders). */
const BAN_IMPORTED = new Set(['do_not_contact']);
/** collabBox komitent ids below this are the legacy register, where Vraboten = Да is a stale default (see komitentOf). */
const LEGACY_KOMITENT_BELOW = 40000;
const MAX_DOC_CHUNK = 500;
/** The apply order (review 28.09): markers first, so a stopped apply never lists a banned phone. */
export const APPLY_PHASES = Object.freeze(['markers', 'orders', 'links', 'ledger', 'customers', 'relabels']);

// ─── small helpers ──────────────────────────────────────────────────────────
const nf = (n) => Math.round(Number(n) || 0).toLocaleString('de-DE');
const eur2 = (n) => (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
const inc = (o, k, by = 1) => { o[k] = (o[k] || 0) + by; return o; };
const bump = (o, k, n = 1, mkd = 0) => { const r = (o[k] ??= { n: 0, mkd: 0 }); r.n += n; r.mkd += mkd; return r; };
const toMs = (v) => (v == null || v === '' ? null : new Date(v).getTime());
const yearOf = (iso) => (T.skopjeDay(iso) || '????').slice(0, 4);
const monthOf = (iso) => (T.skopjeDay(iso) || '????-??').slice(0, 7);

function writeCsvFile(name, rows, cols) {
  mkdirSync(OUT_DIR, { recursive: true });
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join(';') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = cols || [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const body = [header.map(cell).join(','), ...rows.map((r) => header.map((c) => cell(r[c])).join(','))].join('\r\n');
  const path = join(OUT_DIR, name);
  writeFileSync(path, `\uFEFF${body}\r\n`, 'utf8');
  return path;
}

async function pagedRead(build, key, label) {
  const out = [];
  let last = null;
  for (;;) {
    const rows = await sqlRead(build(last));
    out.push(...rows);
    if (rows.length < 20000) break;
    last = rows[rows.length - 1][key];
  }
  if (label) ok(`${label}: ${nf(out.length)}`);
  return out;
}

// ─── 1. sources ─────────────────────────────────────────────────────────────
function loadCrawl(dir) {
  const docs = [];
  for (const t of Object.keys(T.TELESHOP_TYPES)) {
    const path = join(dir, `type_${t}.csv`);
    if (!existsSync(path)) die(`missing ${path}`);
    for (const r of T.csvObjects(readFileSync(path, 'utf8'))) docs.push(T.docFromCsv(r, 'crawl'));
  }
  const otherTypeOf = new Map();
  for (const t of OTHER_TYPES) {
    const path = join(dir, `type_${t}.csv`);
    if (!existsSync(path)) continue;
    for (const r of T.csvObjects(readFileSync(path, 'utf8'))) otherTypeOf.set(String(r.DocNumber).trim(), t);
  }
  return { docs, otherTypeOf };
}

function loadFetch(files) {
  const headers = [], items = new Map();
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const h of j.headers || []) headers.push(T.docFromFetch(h, 'fetch'));
    for (const x of j.items || []) {
      const d = String(x.docNumber || '').trim();
      if (!d) continue;
      (items.get(d) ?? items.set(d, []).get(d)).push({
        code: String(x.articleCode ?? '').trim(), name: T.cleanName(x.article), qty: Number(x.qtyOut) || 0,
        value_mkd: Number(x.saleValueVat) || 0, type_id: x.typeId ? String(x.typeId) : null,
      });
    }
  }
  return { headers, items };
}

function loadKomitenti(path) {
  if (!existsSync(path)) die(`missing ${path}`);
  const m = new Map();
  for (const k of T.csvObjects(readFileSync(path, 'utf8'))) m.set(String(k.Sifra).trim(), k);
  return m;
}

// ─── 2. database (SELECT only) ──────────────────────────────────────────────
async function loadDb({ wantItems }) {
  const orders = await pagedRead((last) => `select o.id, o.display_id, o.customer_phone, o.status::text as status,
        o.price::float8 as price, o.created_at, o.source_type, o.external_source, o.external_order_id,
        o.mex_tracking_id, o.sale_source, o.sale_source_detail, o.trash_reason, o.trashed_at,
        o.confirmed_by_name, o.product_id
      from public.orders o ${last ? `where o.id > ${qUuid(last)}` : ''} order by o.id limit 20000`, 'id', 'orders');
  const parcels = await pagedRead((last) => `select p.tracking_id, p.account, p.series, p.status_id, p.cod_mkd, p.phone8,
        p.created_at_mex, p.delivered_at, p.returned_at, p.last_update_at, p.order_id, p.link_method,
        p.receiver_name, p.receiver_city
      from public.mex_parcels p ${last ? `where p.tracking_id > ${q(last)}` : ''} order by p.tracking_id limit 20000`, 'tracking_id', 'MEX parcels');
  const webClaimed = new Set((await sqlRead(`select distinct w.mex_tracking_id as tr from public.web_orders w
      where w.mex_tracking_id is not null and w.deleted_in_shop_at is null`)).map((r) => r.tr));
  const profiles = await pagedRead((last) => `select c.phone, c.customer_name, c.city, c.street from public.customer_profiles c
      ${last ? `where c.phone > ${q(last)}` : ''} order by c.phone limit 20000`, 'phone', 'customer profiles');
  const excluded = new Set((await sqlRead('select phone8 from public.report_excluded_phones')).map((r) => r.phone8));
  const identities = await sqlRead(`select i.kind, i.value, sp.display_name from public.sales_person_identities i
      join public.sales_people sp on sp.id = i.person_id
     where i.account_id is null and i.kind in ('collabbox_author', 'order_name')`);
  const agentProfiles = await sqlRead(`select p.full_name, coalesce(array_agg(r.role::text) filter (where r.role is not null), '{}') as roles
      from public.profiles p left join public.user_roles r on r.user_id = p.user_id group by p.user_id, p.full_name`);
  const members = await sqlRead(`select m.customer_phone, l.name, l.is_static, (m.assigned_agent_id is not null) as assigned
      from public.prediction_segment_members m join public.prediction_segment_lists l on l.id = m.list_id`);
  let skuMap = new Map();
  let productNames = new Map();
  if (wantItems) {
    const json = JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'collabbox-sku-map.json'), 'utf8'));
    const prods = await sqlRead(`select id, sku, name, is_active from public.products`);
    const byId = new Map(prods.map((p) => [p.id, p]));
    productNames = new Map(prods.map((p) => [p.id, p.name]));
    for (const m of json.matched || []) if (byId.has(m.product_id)) skuMap.set(m.collabbox_sku, { id: m.product_id, name: byId.get(m.product_id).name });
    // the catalogue's own collabBox code wins (the paused sync's finding: 000942 / 000616 / 000944)
    for (const p of prods.filter((x) => /^\d{6}$/.test(x.sku || '')).sort((a, b) => Number(a.is_active) - Number(b.is_active))) skuMap.set(p.sku, { id: p.id, name: p.name });
  }
  ok(`web-claimed parcels ${nf(webClaimed.size)} · test phones ${excluded.size} · seller identities ${identities.length} · segment members ${nf(members.length)}`);
  return { orders, parcels, webClaimed, profiles, excluded, identities, agentProfiles, members, skuMap, productNames };
}

// ─── 3. classify ────────────────────────────────────────────────────────────
function lineRole(l) {
  if (l.code === '8004' || /^купон/iu.test(l.name)) return 'marker';     // КУПОН-НАГРАДНА ИГРА: a loyalty coupon, never a package
  if (l.kind) {
    if (/^(goods|product|gift|sale)$/.test(l.kind)) return 'goods';
    if (/deliver|dostav|shipping/.test(l.kind)) return 'delivery';
    if (/note|comment/.test(l.kind)) return 'note';
    if (/marker|point|poen|loyal|coupon|flyer|flaer/.test(l.kind)) return 'marker';
  }
  if (l.code === '8001' || /^достав/iu.test(l.name)) return 'delivery';
  if (l.code === '8002' || /^забелешк/iu.test(l.name)) return 'note';
  if (/^поен/iu.test(l.code) || /^поен/iu.test(l.name) || /купон/iu.test(l.name)) return 'marker';
  return 'goods';
}

export function classify({ crawl, fetched, komitenti, db, window, nowMs, mexFrom, vrabotenLiteral = false, customersClean = null, confirmAwaiting = false,
  bannedAsTrash = false, keepStornoOriginals = false }) {
  // merge sources: the fetch is newer and wins for the same DocNumber
  const byDoc = new Map();
  const dupDocs = new Set();
  const seenCrawl = new Map();
  for (const d of crawl.docs) {
    if (seenCrawl.has(d.doc_number)) dupDocs.add(d.doc_number);
    seenCrawl.set(d.doc_number, d);
  }
  for (const d of seenCrawl.values()) byDoc.set(d.doc_number, d);
  for (const h of fetched.headers) if (T.TELESHOP_TYPES[h.type_id]) byDoc.set(h.doc_number, h);
  // helper B's headers come from a fresh (28.09) header search: they are the newest word on a
  // document — they win over the 10.09 crawl and the --fetch file, and they add every document
  // raised after the crawl. A crawl / fetch document INSIDE their window that the fresh search no
  // longer returns was deleted, re-typed or re-dated in collabBox since → not a sale (skipped).
  const freshDocs = new Set();
  const freshMonths = new Map();     // YYYY-MM → documents the fresh search returned (a month counts only when it was fetched)
  for (const h of fetched.itemHeaders || []) {
    if (!T.TELESHOP_TYPES[h.type_id]) continue;
    freshDocs.add(h.doc_number);
    const day = T.skopjeDay(h.doc_at);
    if (day) freshMonths.set(day.slice(0, 7), (freshMonths.get(day.slice(0, 7)) || 0) + 1);
    const old = byDoc.get(h.doc_number);
    if (old && old.amount_mkd != null && h.amount_mkd != null && Math.abs(old.amount_mkd - h.amount_mkd) > 0.01) h.amount_changed = old.amount_mkd;
    byDoc.set(h.doc_number, h);
  }
  const lastFreshDay = (fetched.itemHeaders || []).reduce((m, h) => { const d = T.skopjeDay(h.doc_at); return d && d > m ? d : m; }, '');
  const vanished = new Set();
  if (freshDocs.size) {
    for (const d of byDoc.values()) {
      const day = T.skopjeDay(d.doc_at);
      if (!freshDocs.has(d.doc_number) && day && (freshMonths.get(day.slice(0, 7)) || 0) >= 50 && day <= lastFreshDay) vanished.add(d.doc_number);
    }
  }

  const parcels = new Map(db.parcels.map((p) => [p.tracking_id, p]));
  const ordersById = new Map(db.orders.map((o) => [o.id, o]));
  const extCb = new Map();
  const namedBy = new Map();
  const phonesBy8 = new Map();        // last-8 → Map(exact phone string → count)
  const salesBy8 = new Map();         // last-8 → CRM sales with no parcel (twin check)
  const deadBy8 = new Map();          // last-8 → CRM cancels / trashes (information only)
  for (const o of db.orders) {
    if (o.external_source === 'collabbox' && o.external_order_id) extCb.set(o.external_order_id, o);
    if (o.mex_tracking_id) (namedBy.get(o.mex_tracking_id) ?? namedBy.set(o.mex_tracking_id, []).get(o.mex_tracking_id)).push(o);
    const k8 = T.last8(o.customer_phone);
    if (k8.length === 8) {
      const m = phonesBy8.get(k8) ?? phonesBy8.set(k8, new Map()).get(k8);
      m.set(o.customer_phone, (m.get(o.customer_phone) || 0) + 1);
      if (!o.mex_tracking_id && SALE_STATUSES.has(o.status) && o.external_source !== 'collabbox') {
        (salesBy8.get(k8) ?? salesBy8.set(k8, []).get(k8)).push(o);
      }
      if ((o.status === 'cancelled' || o.status === 'trashed') && o.external_source !== 'collabbox') {
        (deadBy8.get(k8) ?? deadBy8.set(k8, []).get(k8)).push(o);
      }
    }
  }
  const profileByPhone = new Map(db.profiles.map((p) => [p.phone, p]));
  for (const p of db.profiles) {
    const k8 = T.last8(p.phone);
    if (k8.length !== 8) continue;
    const m = phonesBy8.get(k8) ?? phonesBy8.set(k8, new Map()).get(k8);
    if (!m.has(p.phone)) m.set(p.phone, 0);
  }
  const identityAuthors = new Map(db.identities.filter((i) => i.kind === 'collabbox_author').map((i) => [i.value, i.display_name]));
  // The header crawl is HTML, which collapses runs of spaces; the seller identities were made from
  // the XLS export, which keeps them ("Ружица  Ружевска"). tg_orders_stamp_sold matches the
  // spelling EXACTLY, so an author is written in the identity's own spelling when the two differ
  // only by whitespace.
  const collapse = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const authorCanon = new Map();
  for (const kind of ['collabbox_author', 'order_name']) {
    for (const i of db.identities.filter((x) => x.kind === kind)) if (!authorCanon.has(collapse(i.value))) authorCanon.set(collapse(i.value), i.value);
  }
  const canonAuthor = (a) => (a == null ? null : authorCanon.get(collapse(a)) ?? a);
  const authorNames = new Set([...crawl.docs.map((x) => collapse(x.author)), ...authorCanon.keys()].filter(Boolean));
  const orderNameIds = new Map(db.identities.filter((i) => i.kind === 'order_name').map((i) => [i.value, i.display_name]));

  // komitent verdicts (once per komitent)
  const kVerdict = new Map();
  const komitentOf = (d) => {
    if (kVerdict.has(d.komitent_id)) return kVerdict.get(d.komitent_id);
    const k = komitenti.get(d.komitent_id) || null;
    const clean = customersClean?.get(String(d.komitent_id));
    // helper A's verdict — except a skip that only says "no phone in the registry": the MEX parcel
    // (the courier's own receiver phone) is still valid evidence, so the interim rules decide those
    if (clean && !['not_in_registry', 'no_valid_phone'].includes(clean.skip)) {
      // helper A (scripts/lib/teleshop-customers.mjs → customers-clean.json) decided this komitent
      // helper A lifted operator notes out of the name; an empty name stays '—' (the parcel's receiver
      // fills it when there is one) — the raw registry name is never used here, it may be only a note
      const name = T.cleanName(clean.name || '') || '—';
      const v = {
        komitent_id: d.komitent_id, k, name, from_clean: true,
        city: T.cleanName(clean.city ?? k?.Grad ?? ''), address: T.cleanName(clean.address ?? k?.Adresa ?? ''),
        p8: clean.p8, phone_why: clean.p8 ? null : (clean.reason || 'no_phone_in_customers_clean'), phone_field: 'customers_clean',
        phone_raw: [k?.Mobilen, k?.Telefon].map((x) => String(x ?? '').trim()).filter(Boolean).join(' | '),
        clean_phone: clean.phone, clean_match: clean.match,
        skip: clean.skip, legacy_da: false, returns_marker: clean.flags.includes('returns_orders'), author_name: authorNames.has(collapse(name)),
        in_crm: clean.in_crm, crm_phone: clean.crm_phone,
      };
      const verdict = T.cleanSkip(clean, { vrabotenLiteral, bannedAsTrash });
      v.skip = verdict.skip;
      if (verdict.ban) v.ban = verdict.ban;
      kVerdict.set(d.komitent_id, v);
      return v;
    }
    const name = T.cleanName(k?.Ime || d.komitent_name) || '—';
    const ph = T.komitentPhone(k);
    let skip = null;
    // Vraboten = Да is NOT an employee flag on the legacy register (Sifra < 40.000: 30.110 of its
    // 30.295 "Да" rows; 426 of them are long-time teleshop buyers with orders in 2023–2026). Only
    // a current-register komitent marked Да, or a name that says "вработен/а", is an employee.
    // --vraboten-literal skips every Да instead (the literal reading of the owner's brief).
    const isDa = !!k && String(k.Vraboten).trim() === 'Да';
    const legacyDa = isDa && Number(k.Sifra) < LEGACY_KOMITENT_BELOW;
    if (/вработен/iu.test(name) || (isDa && (vrabotenLiteral || !legacyDa))) skip = 'employee';
    else if (T.isCompany(k) || (!k && T.COMPANY_RE.test(T.cleanName(d.komitent_name)))) skip = 'company';
    else skip = T.nameMarker(k?.Ime || '') || T.nameMarker(d.komitent_name) || null;
    const v = {
      komitent_id: d.komitent_id, k, name,
      city: T.cleanName(k?.Grad || ''), address: T.cleanName(k?.Adresa || ''),
      p8: ph.p8, phone_why: ph.why, phone_field: ph.field,
      phone_raw: [k?.Mobilen, k?.Telefon].map((x) => String(x ?? '').trim()).filter(Boolean).join(' | '),
      skip, legacy_da: legacyDa, returns_marker: T.RETURNS_MARKER.test(T.cleanName(k?.Ime || d.komitent_name)),
      author_name: authorNames.has(collapse(name)),
    };
    if (BAN_FAMILY[skip]) { v.ban = BAN_FAMILY[skip]; if (bannedAsTrash && BAN_IMPORTED.has(BAN_FAMILY[skip])) v.skip = null; }
    kVerdict.set(d.komitent_id, v);
    return v;
  };

  const phoneFor = (p8) => {
    const m = phonesBy8.get(p8);
    if (!m || !m.size) return { phone: T.e164(p8), match: 'new' };
    const canon = T.e164(p8);
    if (m.has(canon)) return { phone: canon, match: 'existing' };
    // the CRM knows this person only under a malformed spelling (+38938076222888): the new orders
    // carry the clean E.164 — never the malformed string (listed for a phone repair)
    return { phone: canon, match: 'existing_noncanonical', crm_phones: [...m.keys()] };
  };

  // STORNOS (items file: blank amount, negative lines). The document it reverses = the same
  // komitent's earlier document worth exactly the reversed value, ≤ 120 days before; when exactly
  // ONE such document exists it is excluded too (owner: reversed documents are not sales) unless
  // --keep-storno-originals. Ambiguous / unmatched stornos are reported.
  const bannedPhones = new Map();
  const stornoPairs = [];
  const reversedBy = new Map();
  const byKomitent = new Map();
  for (const d of byDoc.values()) if (d.komitent_id) (byKomitent.get(d.komitent_id) ?? byKomitent.set(d.komitent_id, []).get(d.komitent_id)).push(d);
  for (const st of [...byDoc.values()].filter((d) => d.storno)) {
    const value = Math.abs(st.lines_value_mkd || 0);
    const at = toMs(st.doc_at);
    const cands = value > 0 ? (byKomitent.get(st.komitent_id) || []).filter((o) => !o.storno && o.doc_number !== st.doc_number
      && o.amount_mkd != null && Math.abs(o.amount_mkd - value) <= 1 && toMs(o.doc_at) <= at && at - toMs(o.doc_at) <= 120 * T.DAY_MS
      && !reversedBy.has(o.doc_number)) : [];
    const pair = { storno: st.doc_number, storno_at: st.doc_at, komitent_id: st.komitent_id, value_mkd: -value, candidates: cands.length,
      original: cands.length === 1 ? cands[0].doc_number : null, original_at: cands.length === 1 ? cands[0].doc_at : null };
    stornoPairs.push(pair);
    if (pair.original && !keepStornoOriginals) reversedBy.set(pair.original, st.doc_number);
  }

  const fromDay = window.from, toDay = window.to;
  const plans = [];
  const outOfWindow = { n: 0, byYear: {} };
  const docsSorted = [...byDoc.values()].sort((a, b) => String(a.doc_at).localeCompare(String(b.doc_at)) || a.doc_number.localeCompare(b.doc_number));
  const twinsClaimed = new Set();
  for (const d of docsSorted) {
    const day = T.skopjeDay(d.doc_at);
    if (day && (day < fromDay || day > toDay)) { outOfWindow.n++; inc(outOfWindow.byYear, day.slice(0, 4)); continue; }
    const series = T.docSeries(d.doc_number);
    const p = {
      doc: d, doc_number: d.doc_number, type_id: d.type_id, series, day, year: day ? day.slice(0, 4) : '????',
      amount: d.amount_mkd, price: d.amount_mkd > 0 ? T.eurFromMkd(d.amount_mkd) : null,
      outcome: null, reason: null, status: null, basis: null, paid_at: null, shipped_at: null, returned_at: null,
      tracking: null, remember_tracking: false, parcel: null, phone: null, phone8: null, phone_src: null, match: null,
      related: null, flags: [], k: null, items: null, author: canonAuthor(d.author), product_id: null, product_name: T.NO_ITEMS_PRODUCT_NAME, qty: 1,
    };
    plans.push(p);
    const skip = (reason) => { p.outcome = 'skipped'; p.reason = reason; };
    const conflict = (reason, related) => { p.outcome = 'conflict'; p.reason = reason; p.related = related || null; };

    if (dupDocs.has(d.doc_number)) { skip('duplicate_doc_number'); continue; }
    if (vanished.has(d.doc_number) && !extCb.has(d.doc_number)) { skip('not_in_collabbox_anymore'); continue; }
    if (d.storno) { skip('storno'); continue; }
    if (reversedBy.has(d.doc_number) && !extCb.has(d.doc_number)) { skip('reversed_by_storno'); p.related = null; p.flags.push(`storno:${reversedBy.get(d.doc_number)}`); continue; }
    if (d.negative_line) p.flags.push('negative_line_in_document');
    if (d.amount_changed != null) p.flags.push('amount_edited_since_crawl');
    if (d.sum_check === 'mismatch') p.flags.push('lines_sum_differs_from_amount');   // price stays the document amount
    if (!T.DOC_NUMBER_RE.test(d.doc_number)) { skip('bad_doc_number'); continue; }
    if (!d.doc_at) { skip('no_date'); continue; }
    const ex = extCb.get(d.doc_number);
    if (ex) {
      p.outcome = 'exists'; p.reason = vanished.has(d.doc_number) ? 'order_exists_document_deleted' : 'order_exists'; p.related = ex.id; p.existing = ex;
      if (vanished.has(d.doc_number)) p.flags.push('crm_order_on_deleted_document');
      p.k = komitentOf(d);
      continue;
    }
    if (!T.TELESHOP_SERIES.includes(series)) { skip(`series_${series || 'none'}`); continue; }
    if (crawl.otherTypeOf.has(d.doc_number)) { skip('doc_number_in_other_type'); continue; }
    if (d.amount_mkd == null) { skip('no_amount'); continue; }
    if (!(d.amount_mkd > 0)) { skip('replacement_zero_value'); continue; }

    const kv = komitentOf(d);
    p.k = kv;
    if (kv.skip) { skip(`komitent_${kv.skip}`); continue; }

    const parcel = parcels.get(d.doc_number) || null;
    p.parcel = parcel;
    // a komitent newer than the 10.09 registry snapshot has no name here → the parcel's receiver
    if ((!kv.k || kv.name === '—') && parcel?.receiver_name) { p.name = T.cleanName(parcel.receiver_name) || kv.name; p.flags.push('name_from_parcel'); }
    if (!kv.k && !kv.city && parcel?.receiver_city) p.city = T.cleanName(parcel.receiver_city);
    const parcel8 = parcel?.phone8 && T.MK_NSN_RE.test(parcel.phone8) ? parcel.phone8 : null;
    if (kv.p8) { p.phone8 = kv.p8; p.phone_src = 'registry'; }
    else if (parcel8) { p.phone8 = parcel8; p.phone_src = 'parcel'; }
    else { skip(kv.k ? `no_valid_phone_${kv.phone_why}` : 'komitent_not_in_registry'); continue; }
    if (db.excluded.has(p.phone8) || (parcel?.phone8 && db.excluded.has(parcel.phone8))) { skip('test_phone'); continue; }
    if (parcel8 && kv.p8 && parcel8 !== kv.p8) p.flags.push('phone_differs_from_parcel');
    if (kv.returns_marker) p.flags.push('name_says_returns_orders');
    const ph = phoneFor(p.phone8);
    if (kv.from_clean && kv.clean_phone && T.last8(kv.clean_phone) === p.phone8 && p.phone_src === 'registry') {
      p.phone = kv.clean_phone; p.match = kv.clean_match || ph.match;
      if (kv.clean_phone !== ph.phone) p.flags.push('phone_string_from_customers_clean');
    } else { p.phone = ph.phone; p.match = ph.match; }
    if (p.match === 'existing_noncanonical') p.flags.push('crm_phone_malformed_twin');
    if (kv.ban) { p.flags.push(`banned_customer_${kv.ban}`); bannedPhones.set(p.phone, { phone: p.phone, ban: kv.ban, name: p.name || kv.name, komitent_id: kv.komitent_id, source: 'imported' }); }

    if (parcel) {
      if (!(Number(parcel.cod_mkd) > 0)) { skip('replacement_cod0'); continue; }
      if (parcel.order_id) { conflict('parcel_held_by_other_order', parcel.order_id); continue; }
      if (db.webClaimed.has(parcel.tracking_id)) { conflict('parcel_claimed_by_web_order'); continue; }
      const named = (namedBy.get(d.doc_number) || [])[0];
      if (named) { conflict('tracking_named_by_other_order', named.id); continue; }
      const fit = T.codFitsAmount(d.amount_mkd, parcel.cod_mkd);
      if (!fit) p.flags.push('cod_differs_from_amount');
      else if (fit === 'plus_delivery') p.flags.push('cod_plus_delivery');
      Object.assign(p, T.statusFromParcel(parcel));
      p.basis = p.paid_basis; delete p.paid_basis;
      p.tracking = parcel.tracking_id;
    } else {
      const named = (namedBy.get(d.doc_number) || [])[0];
      if (named) { conflict('tracking_named_by_other_order', named.id); continue; }
      if (day < mexFrom) {
        p.status = 'paid'; p.basis = 'legacy_import'; p.paid_at = d.doc_at;
      } else if (nowMs - toMs(d.doc_at) > T.NO_PARCEL_GRACE_DAYS * T.DAY_MS) {
        skip('no_parcel_mex_era'); continue;
      } else if (!confirmAwaiting) {
        // not created YET: a 'confirmed' collabBox order would enter the CRM warehouse Packing
        // queue (teleshop packs from collabBox) and no rule ever cancels it; the next run creates
        // it once MEX has the parcel. --confirm-awaiting creates it as 'confirmed' instead.
        skip('awaiting_parcel'); continue;
      } else {
        p.status = 'confirmed'; p.remember_tracking = true;
      }
    }

    // A CRM sale on this phone with NO parcel of its own, raised around the same time, is most
    // likely THIS sale recorded twice: 2025 AlterCPA leads were shipped under "Нарачка in"
    // documents (measured: 861 such pairs, 80 % on the same or next day, most AlterCPA prices 0 /
    // 895 while the document has the real amount). Nearest first, one document per CRM order:
    //   ±7 days and the amount fits the CRM price  → possible_twin_crm_sale
    //   ±3 days, the amount does not fit           → likely_twin_crm_sale_price_differs
    const at = toMs(d.doc_at);
    const near = (salesBy8.get(p.phone8) || []).filter((o) => !twinsClaimed.has(o.id) && Math.abs(toMs(o.created_at) - at) <= TWIN_WINDOW_MS)
      .sort((a, b) => Math.abs(toMs(a.created_at) - at) - Math.abs(toMs(b.created_at) - at));
    const fitTwin = near.find((o) => T.codFitsAmount(Math.round(Number(o.price) * T.MKD_PER_EUR), d.amount_mkd));
    const looseTwin = fitTwin ? null : near.find((o) => Math.abs(toMs(o.created_at) - at) <= LOOSE_TWIN_MS);
    if (fitTwin) { twinsClaimed.add(fitTwin.id); conflict('possible_twin_crm_sale', fitTwin.id); continue; }
    if (looseTwin) { twinsClaimed.add(looseTwin.id); conflict('likely_twin_crm_sale_price_differs', looseTwin.id); continue; }
    if ((deadBy8.get(p.phone8) || []).some((o) => Math.abs(toMs(o.created_at) - at) <= LOOSE_TWIN_MS)) p.flags.push('near_cancelled_crm_lead');

    // line items (only when a --fetch covered this document)
    const lines = fetched.items.get(d.doc_number);
    if (lines && lines.length) {
      const deliveryMkd = lines.filter((l) => lineRole(l) === 'delivery').reduce((t, l) => t + l.value_mkd, 0);
      if (deliveryMkd > 0) p.flags.push('delivery_fee_in_price');
      const goods = lines.filter((l) => lineRole(l) === 'goods' && (l.qty > 0 || l.value_mkd > 0))
        .map((l) => ({ ...l, product: l.product_id !== undefined
          ? (l.product_id ? { id: l.product_id, name: db.productNames?.get(l.product_id) || l.name } : null)   // helper B's reviewed mapping
          : (db.skuMap.get(l.code) || null) }));
      if (goods.length) {
        p.items = goods.map((l) => {
          const qty = Math.max(1, Math.ceil(l.qty || 1));
          const base = l.product?.name || l.name || '—';
          const label = l.qty_doc && l.qty_doc !== l.qty && l.product ? `${base} (collabBox: ${l.qty_doc} × ${l.name})` : base;
          return { product_id: l.product?.id ?? null, name: label.slice(0, 300), qty,
            ppu: Math.round((l.value_mkd / qty / T.MKD_PER_EUR) * 100) / 100, total: T.eurFromMkd(l.value_mkd) };
        });
        const top = [...goods].sort((a, b) => b.value_mkd - a.value_mkd)[0];
        p.product_id = goods.find((l) => l.product)?.product?.id ? ([...goods].filter((l) => l.product).sort((a, b) => b.value_mkd - a.value_mkd)[0].product.id) : null;
        p.product_name = goods.map((l) => l.product?.name || l.name).join(' + ').slice(0, 300) || T.NO_ITEMS_PRODUCT_NAME;
        p.qty = Math.max(1, goods.reduce((s, l) => s + Math.ceil(l.qty || 0), 0));
        if (goods.some((l) => !l.product)) p.flags.push('unmapped_item');
        if (!top) p.flags.push('no_goods_line');
        p.flags.push('items_from_fetch');
      } else p.flags.push('no_items');
    } else p.flags.push('no_items');

    if (!p.author) p.flags.push('no_author');
    else if (!identityAuthors.has(p.author) && !orderNameIds.has(p.author)) p.flags.push('author_unmapped');
    else if (p.author !== d.author) p.flags.push('author_spacing_from_identity');
    if (kv.legacy_da) p.flags.push('vraboten_legacy_flag');
    if (kv.author_name) p.flags.push('name_equals_an_operator');
    p.outcome = 'created';
    p.reason = p.parcel ? `parcel_${p.status}` : p.basis === 'legacy_import' ? 'pre_mex_legacy' : 'mex_era_to_pack';
  }

  // LINKS (review 28.09 #8): an EXISTING collabBox order (teleshop, LEADS, LEADS-OUT, social) whose
  // OWN parcel — tracking id = its DocNumber — sits unlinked in the register counts twice (order +
  // MEX-only parcel). Linked with mex_link_parcel(…, 'collabbox_import', no force) only when it is
  // unambiguous: parcel free, COD > 0, not web-claimed, nobody else names it, the order names no
  // other parcel, same phone (last-8), and the order is a sale (a cancelled / trashed one is listed,
  // not linked — the owner decides those). NOT part of the plan hash: re-evaluated and idempotent at
  // apply time, so a resume never depends on links the run itself made.
  const links = [], linkSkipped = [];
  for (const o of db.orders) {
    if (o.external_source !== 'collabbox' || !o.external_order_id) continue;
    const parcel = parcels.get(o.external_order_id);
    if (!parcel || parcel.order_id) continue;
    const row = { order_id: o.id, display_id: o.display_id, doc: o.external_order_id, detail: o.sale_source_detail, status: o.status,
      parcel_status: parcel.status_id, cod_mkd: parcel.cod_mkd, price_mkd: Math.round(Number(o.price || 0) * T.MKD_PER_EUR) };
    const o8 = T.last8(o.customer_phone);
    const why = !(Number(parcel.cod_mkd) > 0) ? 'cod0'
      : db.webClaimed.has(parcel.tracking_id) ? 'web_claimed'
      : (namedBy.get(parcel.tracking_id) || []).some((x) => x.id !== o.id) ? 'named_by_other_order'
      : o.mex_tracking_id && o.mex_tracking_id !== parcel.tracking_id ? 'order_names_other_parcel'
      : parcel.phone8 && o8.length === 8 && parcel.phone8 !== o8 ? 'phone_differs'
      : !SALE_STATUSES.has(o.status) ? `status_${o.status}` : null;
    (why ? linkSkipped : links).push(why ? { ...row, why } : row);
  }

  const isCrmPhone = (p8) => !!phonesBy8.get(p8)?.size;
  // banned (deceased / do-not-contact) komitenti the CRM ALREADY holds as customers: a trash marker
  // on every exact CRM spelling of that phone (the engine keys on the exact string) — optional step
  const existingBanned = [];
  if (customersClean) {
    const seen = new Set();
    for (const [kid, c] of customersClean) {
      const fam = BAN_FAMILY[c.skip];
      if (!fam || !c.p8) continue;
      for (const phone of phonesBy8.get(c.p8)?.keys() || []) {
        if (seen.has(phone)) continue;
        seen.add(phone);
        existingBanned.push({ phone, ban: fam, komitent_id: kid, name: c.name, source: 'existing', crm_orders: phonesBy8.get(c.p8).get(phone) || 0 });
      }
    }
  }
  // Existing collabBox orders the series rule labelled 'teleshop' whose document is NOT a teleshop
  // document: LEADS-OUT (10114) / LEADS (10111) numbered in series 9102 (the 2026-08-12 register
  // import and the September import). Reported; relabelled only with --relabel-source.
  const TYPE_TO_DETAIL = { '10114': 'leads_out', '10111': 'leads', '10106': 'social' };
  const mislabelled = [];
  for (const o of db.orders) {
    if (o.external_source !== 'collabbox' || o.sale_source_detail !== 'teleshop' || !o.external_order_id) continue;
    if (byDoc.has(o.external_order_id)) continue;
    const t = crawl.otherTypeOf.get(o.external_order_id) || null;
    mislabelled.push({ order_id: o.id, display_id: o.display_id, doc_number: o.external_order_id, status: o.status, created_at: o.created_at,
      doc_type: t, target: TYPE_TO_DETAIL[t] || null });
  }
  const reused = [...dupDocs].map((n) => ({ doc_number: n, documents: crawl.docs.filter((x) => x.doc_number === n).map((x) => `${x.doc_id} ${x.datum_raw} ${x.amount_mkd} ${x.author}`).join(' || '),
    crm_order: extCb.get(n)?.display_id || null, parcel: parcels.get(n) ? `${parcels.get(n).status_id}/${parcels.get(n).order_id ? 'held' : 'free'}` : null }));
  return { plans, outOfWindow, dupDocs, kVerdict, identityAuthors, orderNameIds, ordersById, parcels, profileByPhone, isCrmPhone, mislabelled,
    bannedPhones, existingBanned, stornoPairs, reused, links, linkSkipped };
}

// ─── 4. customers ───────────────────────────────────────────────────────────
/**
 * resumeCreated: Map DocNumber → { phone, match } of the documents THIS run already created (a
 * resumed apply sees them as 'exists'); they count as created so their komitenti still get their
 * customer_profiles row and the right ledger outcome.
 */
export function buildCustomers(plans, kVerdict, profileByPhone, isCrmPhone = () => false, resumeCreated = null) {
  const byK = new Map();
  for (const p0 of plans) {
    const rc = p0.outcome === 'exists' && resumeCreated?.get(p0.doc_number);
    const p = rc ? { ...p0, outcome: 'created', phone: rc.phone, match: rc.match } : p0;
    if (!p.k) continue;
    const c = byK.get(p.k.komitent_id) ?? byK.set(p.k.komitent_id, { kv: p.k, docs: 0, created: 0, exists: 0, phone: null, match: null, reasons: {}, lastAt: null }).get(p.k.komitent_id);
    c.docs++;
    if (p.outcome === 'created') { c.created++; c.phone = p.phone; c.match = p.match; if (p.name) c.altName = p.name; if (!c.lastAt || p.doc.doc_at > c.lastAt) c.lastAt = p.doc.doc_at; }
    else if (p.outcome === 'exists' || p.outcome === 'enriched') c.exists++;
    else inc(c.reasons, p.reason);
  }
  const rows = [];
  const phonePrimary = new Map();   // phone → the komitent whose name / address feeds the profile
  for (const [kid, c] of byK) {
    let outcome, reason = null;
    if (c.created > 0) outcome = c.match;
    else if (c.kv.skip) { outcome = 'skipped'; reason = c.kv.skip; }
    else if (!c.kv.p8 && !c.created) { outcome = 'skipped'; reason = Object.keys(c.reasons).sort((a, b) => c.reasons[b] - c.reasons[a])[0] || `no_valid_phone_${c.kv.phone_why}`; }
    else if (c.exists && !c.created) { outcome = 'existing'; reason = 'orders_already_in_crm'; }
    else {
      const top = Object.keys(c.reasons).sort((a, b) => c.reasons[b] - c.reasons[a])[0] || 'no_importable_document';
      // every document was a conflict / skip, but the phone IS a CRM customer (e.g. the sale is
      // the AlterCPA order its document twins) → existing, nothing written for it
      if (c.kv.p8 && isCrmPhone(c.kv.p8)) { outcome = 'existing'; reason = `no_new_order:${top}`; }
      else { outcome = 'skipped'; reason = top; }
    }
    const row = { komitent_id: kid, name: c.kv.name === '—' && c.altName ? c.altName : c.kv.name, phone8: c.kv.p8, phone_raw: c.kv.phone_raw, phone_field: c.kv.phone_field,
      customer_phone: c.phone, outcome, reason, docs: c.docs, created_orders: c.created, city: c.kv.city, address: c.kv.address, lastAt: c.lastAt,
      rules: c.kv.from_clean ? 'customers_clean' : 'interim' };
    rows.push(row);
    if (c.created > 0 && c.phone) {
      const cur = phonePrimary.get(c.phone);
      if (!cur || c.lastAt > cur.lastAt) phonePrimary.set(c.phone, row);
    }
  }
  for (const [phone, row] of phonePrimary) {
    const prof = profileByPhone.get(phone);
    row.primary = true;
    if (!prof) row.profile_action = 'inserted';
    else {
      const fill = {};
      if (!String(prof.customer_name ?? '').trim() && row.name && row.name !== '—') fill.customer_name = prof.customer_name ?? null;
      if (!String(prof.city ?? '').trim() && row.city) fill.city = prof.city ?? null;
      if (!String(prof.street ?? '').trim() && row.address) fill.street = prof.street ?? null;
      row.profile_action = Object.keys(fill).length ? 'filled' : 'none';
      if (row.profile_action === 'filled') row.profile_before = fill;
    }
  }
  return rows;
}

// ─── 5. the segment blast radius (engine mirror, read-only) ─────────────────
export function segmentBlastRadius({ plans, db, nowMs, markers = [] }) {
  const byPhone = new Map();
  const engRow = (o) => ({ status: o.status, created_at: toMs(o.created_at), price: Number(o.price) || 0, source_type: o.source_type,
    trash_reason: o.trash_reason, trashed_at: toMs(o.trashed_at) });
  for (const o of db.orders) {
    if (!o.customer_phone) continue;
    (byPhone.get(o.customer_phone) ?? byPhone.set(o.customer_phone, []).get(o.customer_phone)).push(engRow(o));
  }
  const add = new Map();
  for (const p of plans) {
    if (p.outcome !== 'created') continue;
    (add.get(p.phone) ?? add.set(p.phone, []).get(p.phone)).push({ status: p.status, created_at: toMs(p.doc.doc_at), price: p.price,
      source_type: 'import', trash_reason: null, trashed_at: null });
  }
  for (const m of markers) {
    (add.get(m.phone) ?? add.set(m.phone, []).get(m.phone)).push({ status: 'trashed', created_at: nowMs, price: 0,
      source_type: 'manual', trash_reason: 'other', trashed_at: nowMs });
  }
  const actual = new Map();
  const listTotals = {};
  for (const m of db.members) {
    inc(listTotals, m.name);
    const a = actual.get(m.customer_phone) ?? actual.set(m.customer_phone, { rule: null, returns: false, trash: false, assigned: false }).get(m.customer_phone);
    if (m.name === 'Current Returns') a.returns = true;
    else if (m.name === 'Trash List') a.trash = true;
    else if (!m.is_static) { a.rule = m.name; if (m.assigned) a.assigned = true; }
  }
  const delta = {};
  const transitions = {};
  const phones = [];
  let mirrorAgree = 0, mirrorChecked = 0;
  const S = { phones: add.size, new_phones: 0, existing_phones: 0, released_from_trash: 0, into_trash: 0, into_newcomers: 0,
    assigned_moving: 0, unchanged: 0, newcomers_assignment_stripped: 0, returns_added: 0, returns_removed: 0 };
  for (const [phone, newRows] of add) {
    const cur = byPhone.get(phone) || [];
    const before = cur.length ? T.engineClassify(cur, nowMs) : { target: null, returns: false, trash: false, paid_count: 0, none: true };
    const after = T.engineClassify([...cur, ...newRows], nowMs);
    if (cur.length) {
      S.existing_phones++;
      const a = actual.get(phone) || { rule: null, returns: false, trash: false };
      mirrorChecked++;
      if ((a.rule || null) === (before.target || null) && a.trash === before.trash && a.returns === before.returns) mirrorAgree++;
    } else S.new_phones++;
    const b = before.target || '(no list)', f = after.target || '(no list)';
    if (b !== f) { inc(delta, b, -1); inc(delta, f, 1); inc(transitions, `${b} → ${f}`); }
    if (before.returns !== after.returns) { inc(delta, 'Current Returns', after.returns ? 1 : -1); inc(S, after.returns ? 'returns_added' : 'returns_removed'); }
    if (before.trash !== after.trash) { inc(delta, 'Trash List', after.trash ? 1 : -1); inc(S, after.trash ? 'into_trash' : 'released_from_trash'); }
    if (b === f && before.returns === after.returns && before.trash === after.trash) S.unchanged++;
    if (f.startsWith('NEWCOMERS') && !b.startsWith('NEWCOMERS')) { S.into_newcomers++; if (actual.get(phone)?.assigned) S.newcomers_assignment_stripped++; }
    if (actual.get(phone)?.assigned && b !== f) S.assigned_moving++;
    phones.push({ phone, existing_orders: cur.length, new_orders: newRows.length, before: b, after: f,
      before_trash: before.trash, after_trash: after.trash, before_returns: before.returns, after_returns: after.returns,
      paid_before: before.paid_count, paid_after: after.paid_count, assigned: !!actual.get(phone)?.assigned });
  }
  const lists = [...new Set([...Object.keys(listTotals), ...Object.keys(delta)])].filter((n) => n !== '(no list)')
    .map((name) => ({ list: name, now: listTotals[name] || 0, change: delta[name] || 0, projected: (listTotals[name] || 0) + (delta[name] || 0) }))
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || a.list.localeCompare(b.list));
  const topTransitions = Object.entries(transitions).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([t, n]) => ({ transition: t, phones: n }));
  S.mirror_fidelity = mirrorChecked ? Math.round((1000 * mirrorAgree) / mirrorChecked) / 10 : null;
  S.members_now = db.members.length;
  S.members_projected = db.members.length + Object.entries(delta).filter(([k]) => k !== '(no list)').reduce((s, [, v]) => s + v, 0);
  return { S, lists, topTransitions, phones };
}

/** The same plan, cut at three start dates — what each scope the owner can choose would do. */
export function scopeVariants({ plans, db, nowMs, scopes }) {
  return scopes.map(({ key, label, from }) => {
    const sub = plans.filter((p) => p.outcome === 'created' && p.day >= from);
    const phones = { new: new Set(), existing: new Set() };
    const basis = {};
    let mkd = 0;
    for (const p of sub) { mkd += p.amount; (p.match === 'new' ? phones.new : phones.existing).add(p.phone); bump(basis, p.status === 'paid' ? `paid_${p.basis}` : p.status, 1, p.amount); }
    const b = segmentBlastRadius({ plans: sub, db, nowMs }).S;
    return { key, label, from, orders: sub.length, mkd, basis, new_phones: phones.new.size, existing_phones: phones.existing.size,
      members_projected: b.members_projected, released_from_trash: b.released_from_trash, phones_changed: b.phones - b.unchanged };
  });
}

// ─── 6. the Insights cohort, before / after (read-only simulation) ──────────
async function cohortSimulation({ plans, parcels, nowMs }) {
  const to = new Date(nowMs).toISOString();
  const rows = await sqlRead(`select kind, source, split, bucket, in_total, value_mkd::float8 as value_mkd, sale_day::text as sale_day, tracking_id
      from public.insights_sale_rows('2026-01-01 00:00+01'::timestamptz, ${q(to)}::timestamptz, false)`);
  const years = [];
  for (const y of ['2023', '2024', '2025']) {        // the function refuses windows > 800 days
    years.push(...await sqlRead(`select ${q(y)} as y, source, count(*) filter (where in_total)::int as n,
          coalesce(sum(value_mkd) filter (where in_total), 0)::float8 as mkd
        from public.insights_sale_rows('${y}-01-01 00:00+01'::timestamptz, '${y}-12-31 23:59:59.999+01'::timestamptz, false)
       group by 1, 2`));
  }
  const mexOnly = new Map(rows.filter((r) => r.kind === 'mex' && r.tracking_id).map((r) => [r.tracking_id, r]));
  const before = {}, after = {};
  const keyOf = (r) => `${r.sale_day.slice(0, 7)}|${r.source}|${r.split}|${r.bucket}`;
  const put = (acc, r, sign = 1) => { const k = keyOf(r); const a = (acc[k] ??= { n: 0, mkd: 0, in_total: r.in_total }); a.n += sign; a.mkd += sign * (Number(r.value_mkd) || 0); };
  for (const r of rows) { put(before, r); put(after, r); }
  const moved = { n: 0, mkd: 0, shiftedMonth: 0, shiftedMonthMkd: 0, shifted0927: 0 };
  const added = [];
  const sep = { from: '2026-09-01', to: '2026-09-27' };
  const sepDelta = { before: { n: 0, mkd: 0 }, after: { n: 0, mkd: 0 } };
  for (const p of plans) {
    if (p.outcome !== 'created') continue;
    const day = T.skopjeDay(p.doc.doc_at);
    let row;
    if (p.parcel) {
      const pr = p.parcel;
      const bucket = T.cohortOrderBucket({ status: p.status, price: p.price, paid_basis: p.basis, tracking: pr.tracking_id,
        mex_status_id: pr.status_id, mex_cod_mkd: pr.cod_mkd, mex_delivered_at: pr.delivered_at });
      row = { sale_day: day, source: 'teleshop_other', split: 'teleshop', bucket, in_total: T.cohortInTotal(bucket), value_mkd: Number(pr.cod_mkd) || 0 };
      const old = mexOnly.get(pr.tracking_id);
      if (old) {
        put(after, old, -1);
        moved.n++; moved.mkd += old.in_total ? Number(old.value_mkd) : 0;
        if (old.sale_day.slice(0, 7) !== day.slice(0, 7)) { moved.shiftedMonth++; moved.shiftedMonthMkd += Number(old.value_mkd) || 0; }
      }
    } else {
      const bucket = T.cohortOrderBucket({ status: p.status, price: p.price, paid_basis: p.basis, tracking: null });
      row = { sale_day: day, source: 'teleshop_other', split: 'teleshop', bucket, in_total: T.cohortInTotal(bucket), value_mkd: Math.round(p.price * T.MKD_PER_EUR) };
    }
    if (day >= '2026-01-01') put(after, row); else if (!p.parcel) added.push(row);
  }
  const months = {};
  for (const [acc, side] of [[before, 'before'], [after, 'after']]) {
    for (const [k, v] of Object.entries(acc)) {
      if (!v.in_total) continue;
      const [m, source, split] = k.split('|');
      const r = (months[m] ??= { month: m, before_n: 0, before_mkd: 0, after_n: 0, after_mkd: 0, tele_before_mkd: 0, tele_after_mkd: 0, mex_teleshop_before_mkd: 0, mex_teleshop_after_mkd: 0, collabbox_teleshop_after_mkd: 0, legacy_after_mkd: 0 });
      r[`${side}_n`] += v.n; r[`${side}_mkd`] += v.mkd;
      if (source === 'teleshop_other') r[`tele_${side}_mkd`] += v.mkd;
      if (split === 'mex_teleshop') r[`mex_teleshop_${side}_mkd`] += v.mkd;
      if (side === 'after' && split === 'teleshop') r.collabbox_teleshop_after_mkd += v.mkd;
    }
  }
  // the pre-MEX money this import ADDS (not moved from a MEX-only parcel)
  for (const p of plans) {
    if (p.outcome !== 'created' || p.parcel || p.basis !== 'legacy_import') continue;
    const m = T.skopjeDay(p.doc.doc_at).slice(0, 7);
    if (months[m]) months[m].legacy_after_mkd += Math.round(p.price * T.MKD_PER_EUR);
  }
  // 01–27.09 exactly (day grain)
  for (const r of rows) if (r.in_total && r.sale_day >= sep.from && r.sale_day <= sep.to) { sepDelta.before.n++; sepDelta.before.mkd += Number(r.value_mkd); }
  sepDelta.after = { ...sepDelta.before };
  for (const p of plans) {
    if (p.outcome !== 'created') continue;
    const day = T.skopjeDay(p.doc.doc_at);
    const old = p.parcel ? mexOnly.get(p.parcel.tracking_id) : null;
    if (old && old.in_total && old.sale_day >= sep.from && old.sale_day <= sep.to) { sepDelta.after.n--; sepDelta.after.mkd -= Number(old.value_mkd); }
    const newVal = p.parcel ? Number(p.parcel.cod_mkd) : Math.round(p.price * T.MKD_PER_EUR);
    const b = p.parcel ? T.cohortOrderBucket({ status: p.status, price: p.price, paid_basis: p.basis, tracking: p.parcel.tracking_id, mex_status_id: p.parcel.status_id, mex_cod_mkd: p.parcel.cod_mkd, mex_delivered_at: p.parcel.delivered_at })
      : T.cohortOrderBucket({ status: p.status, price: p.price, paid_basis: p.basis, tracking: null });
    if (T.cohortInTotal(b) && day >= sep.from && day <= sep.to) { sepDelta.after.n++; sepDelta.after.mkd += newVal; }
  }
  const legacyByYear = {};
  for (const r of added) { const y = r.sale_day.slice(0, 4); bump(legacyByYear, y, 1, r.value_mkd); }
  const yearsBefore = {};
  for (const r of years) bump(yearsBefore, r.y, r.n, r.mkd);
  // teleshop parcels that stay MEX-only after the import (why they could not become orders)
  const remaining = {};
  const created = new Set(plans.filter((p) => p.outcome === 'created' && p.parcel).map((p) => p.parcel.tracking_id));
  const planByDoc = new Map(plans.map((p) => [p.doc_number, p]));
  for (const r of mexOnly.values()) {
    if (r.split !== 'mex_teleshop' || created.has(r.tracking_id)) continue;
    const p = planByDoc.get(r.tracking_id);
    const why = p ? `${p.outcome}:${p.reason}` : (r.sale_day > '2026-09-10' ? 'no_document_in_crawl_after_10.09' : 'no_document_in_crawl');
    bump(remaining, why, 1, r.in_total ? Number(r.value_mkd) : 0);
  }
  return { months: Object.values(months).sort((a, b) => a.month.localeCompare(b.month)), moved, sep: sepDelta, legacyByYear, yearsBefore, remaining };
}

// ─── 7. the plan line (what the hash covers) ────────────────────────────────
export const planLine = (p) => [p.doc_number, p.outcome, p.reason, p.status ?? '', p.basis ?? '', p.phone ?? '', p.price != null ? eur2(p.price) : '',
  p.tracking ?? '', p.parcel?.status_id ?? '', p.parcel?.cod_mkd ?? '', p.related ?? ''].join('|');

// ─── 8. report ──────────────────────────────────────────────────────────────
const REASON_MK = {
  created: 'Ќе се креира нарачка', skipped: 'Исклучено', exists: 'Нарачката веќе постои во CRM', enriched: 'Постои — се дополнуваат празни полиња', conflict: 'Конфликт — не се креира',
  parcel_paid: 'пратка доставена (MEX 2) → платена', parcel_returned: 'пратка вратена (MEX 7) → вратена', parcel_shipped: 'пратка кај курир → испратена',
  pre_mex_legacy: 'пред MEX (пред 30.03.2026) → платена по правилото од 12.08 (legacy_import)', mex_era_to_pack: 'MEX период, без пратка ≤14 дена → за пакување',
  order_exists: 'нарачка со овој број веќе постои', storno: 'сторно документ (без износ, негативни ставки)', reversed_by_storno: 'документот е сториран (поништен) со подоцнежно сторно',
  order_exists_document_deleted: 'нарачката постои, но документот е избришан во collabBox — за проверка', not_in_collabbox_anymore: 'документот го нема повеќе во collabBox (избришан / префрлен по 10.09)', duplicate_doc_number: 'дупликат број на документ', bad_doc_number: 'неисправен број на документ', no_date: 'нема датум',
  doc_number_in_other_type: 'бројот постои и во друг тип документ', no_amount: 'нема износ', replacement_zero_value: 'замена — вредност 0',
  replacement_cod0: 'замена — пратка со откуп 0', awaiting_parcel: 'MEX период, пратката уште не е кај MEX (≤7 дена) — ќе се креира кога ќе ја има', komitent_employee: 'вработен (Vraboten = Да во тековниот регистар, или „вработен/а“ во името)', komitent_company: 'фирма / продавница / институција',
  komitent_deceased: 'во името пишува: починат/а', komitent_do_not_contact: 'во името пишува: да не се контактира', komitent_wrong_number: 'во името пишува: погрешен број',
  komitent_test: 'тест запис', komitent_not_in_registry: 'комитентот го нема во регистарот и нема пратка', test_phone: 'тест телефон на сопственикот',
  no_parcel_mex_era: 'MEX период, нема пратка >7 дена → не е испратена', parcel_held_by_other_order: 'пратката ја држи друга нарачка',
  parcel_claimed_by_web_order: 'пратката е на веб-нарачка', tracking_named_by_other_order: 'друга нарачка го носи овој број на пратка',
  possible_twin_crm_sale: 'дупликат: CRM продажба на ист телефон ±7 дена со ист износ, без своја пратка',
  likely_twin_crm_sale_price_differs: 'дупликат: CRM продажба на ист телефон ±3 дена (друг износ), без своја пратка — најчесто AlterCPA 2025 испратена како „Нарачка in“',
  moved_since_dry_run: 'променето по пробата — не е допрено', created_concurrently: 'креирано паралелно од друг процес',
};
const reasonMk = (r) => REASON_MK[r] || (r?.startsWith('series_') ? `серија ${r.slice(7)} (${T.SERIES_MEANING[r.slice(7)] || 'не е телешоп'})` : r?.startsWith('no_valid_phone_') ? `нема валиден македонски телефон (${r.slice(15)})` : r?.startsWith('fill_') ? `дополнување: ${r.slice(5)}` : r);
const STATUS_MK = { paid: 'Платена', returned: 'Вратена', shipped: 'Кај курир', confirmed: 'За пакување' };
const BASIS_MK = { mex: 'MEX потврдено', legacy_import: 'Пред MEX — правило 12.08 (непотврдено)' };

function summarize({ plans, customers, cls, blast, cohort, window, db, mexFrom }) {
  const S = { byOutcome: {}, byReason: {}, byYearType: {}, created: { byStatus: {}, byYear: {}, byMonth2026: {} }, flags: {}, authors: {}, customers: {} };
  for (const p of plans) {
    const mkd = p.amount > 0 ? p.amount : 0;
    bump(S.byOutcome, p.outcome, 1, mkd);
    bump(S.byReason, `${p.outcome}:${p.reason}`, 1, mkd);
    const yt = (S.byYearType[`${p.year}|${p.type_id}`] ??= { year: p.year, type: T.TELESHOP_TYPES[p.type_id] || p.type_id, docs: 0, docs_mkd: 0, created: 0, created_mkd: 0, exists: 0, conflict: 0, skipped: 0, skipped_mkd: 0, paid_mex: 0, paid_legacy: 0, returned: 0, shipped: 0, confirmed: 0 });
    yt.docs++; yt.docs_mkd += mkd;
    if (p.outcome === 'created') {
      yt.created++; yt.created_mkd += mkd;
      if (p.status === 'paid') yt[p.basis === 'mex' ? 'paid_mex' : 'paid_legacy']++; else yt[p.status]++;
      bump(S.created.byStatus, `${p.status}|${p.basis || ''}`, 1, mkd);
      bump(S.created.byYear, p.year, 1, mkd);
      if (p.year === '2026') bump(S.created.byMonth2026, p.day.slice(0, 7), 1, mkd);
      for (const f of p.flags) inc(S.flags, f);
      const a = (S.authors[p.author || '(нема автор)'] ??= { author: p.author || '(нема автор)', docs: 0, mkd: 0, mapped: cls.identityAuthors.get(p.author) || cls.orderNameIds.get(p.author) || '' });
      a.docs++; a.mkd += mkd;
    } else if (p.outcome === 'exists' || p.outcome === 'enriched') yt.exists++;
    else if (p.outcome === 'conflict') yt.conflict++;
    else { yt.skipped++; yt.skipped_mkd += mkd; }
  }
  for (const c of customers) bump(S.customers, `${c.outcome}${c.reason ? ':' + c.reason : ''}`, 1, 0);
  S.customerRules = customers.reduce((a, c) => inc(a, c.rules), {});
  // customers by distinct phone
  const phones = { new: new Set(), existing: new Set(), existing_noncanonical: new Set() };
  for (const p of plans) if (p.outcome === 'created') phones[p.match]?.add(p.phone);
  S.phones = { new: phones.new.size, existing: phones.existing.size, existing_noncanonical: phones.existing_noncanonical.size };
  S.profiles = { inserted: customers.filter((c) => c.profile_action === 'inserted').length, filled: customers.filter((c) => c.profile_action === 'filled').length };
  // bonus risk: authors equal to a CRM agent's profile name
  const normAgent = (raw) => String(raw || '').trim().replace(/\s+/g, ' ').replace(/\s+\p{L}\.?$/u, '').trim();
  const agentNames = new Set(db.agentProfiles.filter((p) => !(p.roles || []).some((r) => r === 'admin' || r === 'manager')).map((p) => normAgent(p.full_name)));
  S.bonusRiskAuthors = Object.values(S.authors).filter((a) => agentNames.has(normAgent(a.author))).map((a) => ({ author: a.author, docs: a.docs, mkd: a.mkd }));
  S.window = window; S.mexFrom = mexFrom; S.outOfWindow = cls.outOfWindow;
  S.segments = blast?.S || null;
  S.cohort = cohort ? { moved: cohort.moved, sep: cohort.sep, legacyByYear: cohort.legacyByYear, remaining: cohort.remaining } : null;
  return S;
}

function printReport(S, blast, cohort) {
  const H = (t) => console.log(`\n${bold('── ' + t + ' ' + '─'.repeat(Math.max(0, 70 - t.length)))}`);
  H(`TELESHOP IMPORT — dry run, window ${S.window.from} → ${S.window.to} (MEX coverage from ${S.mexFrom})`);
  console.table(Object.entries(S.byOutcome).map(([k, v]) => ({ outcome: k, docs: v.n, 'ден (Iznos)': nf(v.mkd), EUR: nf(v.mkd / T.MKD_PER_EUR) })));
  H('by reason');
  console.table(Object.entries(S.byReason).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ reason: k, docs: v.n, 'ден': nf(v.mkd) })));
  H('by year × type');
  console.table(Object.values(S.byYearType).sort((a, b) => a.year.localeCompare(b.year) || a.type.localeCompare(b.type)).map((r) => ({ ...r, docs_mkd: nf(r.docs_mkd), created_mkd: nf(r.created_mkd), skipped_mkd: nf(r.skipped_mkd) })));
  H('orders to create — status × basis');
  console.table(Object.entries(S.created.byStatus).map(([k, v]) => ({ status: k.split('|')[0], basis: k.split('|')[1] || '—', orders: v.n, 'ден': nf(v.mkd), EUR: nf(v.mkd / T.MKD_PER_EUR) })));
  console.log(`  flags on created orders: ${Object.entries(S.flags).map(([k, v]) => `${k} ×${nf(v)}`).join(', ') || '—'}`);
  H('customers');
  console.log(`  distinct phones receiving orders: new ${nf(S.phones.new)} · existing CRM customers ${nf(S.phones.existing)} · existing with a non-E.164 CRM phone ${nf(S.phones.existing_noncanonical)}`);
  console.log(`  customer_profiles: insert ${nf(S.profiles.inserted)} · fill empty fields ${nf(S.profiles.filled)}`);
  console.table(Object.entries(S.customers).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ komitent: k, count: v.n })));
  const unm = Object.values(S.authors).filter((a) => !a.mapped).sort((a, b) => b.docs - a.docs);
  console.log(`  authors on created orders: ${Object.keys(S.authors).length} (${unm.length} without a collabbox_author / order_name identity → keep sold_by_ext)`);
  for (const a of unm.slice(0, 30)) console.log(`    unmapped  ${a.author.padEnd(30)} ${String(a.docs).padStart(6)} docs  ${nf(a.mkd)} ден`);
  if (S.bonusRiskAuthors.length) console.log(yellow(`  ! ${S.bonusRiskAuthors.length} author(s) equal a CRM agent's profile name → their imported PAID orders enter the per-package bonus: ${S.bonusRiskAuthors.map((a) => `${a.author} ×${a.docs}`).join(', ')}`));
  if (blast) {
    H('prediction lists — blast radius (engine v3.7-mk mirror)');
    const s = blast.S;
    console.log(`  phones touched ${nf(s.phones)} (new ${nf(s.new_phones)}, existing ${nf(s.existing_phones)}); unchanged ${nf(s.unchanged)}; mirror agrees with today's members on ${s.mirror_fidelity}% of the existing phones`);
    console.log(`  released from Trash List by a later paid teleshop order ${nf(s.released_from_trash)} · into Trash ${nf(s.into_trash)} · into NEWCOMERS ${nf(s.into_newcomers)} · assigned members that move ${nf(s.assigned_moving)}`);
    console.log(`  members ${nf(s.members_now)} → ${nf(s.members_projected)}`);
    console.table(blast.lists.filter((l) => l.change).slice(0, 45));
    console.table(blast.topTransitions.slice(0, 20));
  }
  if (cohort) {
    H('Insights cohort — before / after (in_total, ден)');
    console.table(cohort.months.map((m) => ({ month: m.month, 'total before': nf(m.before_mkd), 'total after': nf(m.after_mkd), delta: nf(m.after_mkd - m.before_mkd), 'legacy added': nf(m.legacy_after_mkd),
      'delta w/o legacy': nf(m.after_mkd - m.before_mkd - m.legacy_after_mkd), 'n before': m.before_n, 'n after': m.after_n,
      'MEX-only teleshop before': nf(m.mex_teleshop_before_mkd), 'MEX-only teleshop after': nf(m.mex_teleshop_after_mkd), 'collabBox teleshop after': nf(m.collabbox_teleshop_after_mkd) })));
    console.log(`  01–27.09: ${nf(cohort.sep.before.n)} sales / ${nf(cohort.sep.before.mkd)} ден → ${nf(cohort.sep.after.n)} / ${nf(cohort.sep.after.mkd)} ден`);
    console.log(`  MEX-only parcels that become collabBox orders: ${nf(cohort.moved.n)} (${nf(cohort.moved.mkd)} ден); ${nf(cohort.moved.shiftedMonth)} change month (document day ≠ parcel day, ${nf(cohort.moved.shiftedMonthMkd)} ден)`);
    console.log(`  legacy (pre-MEX, paid_legacy) added before 2026: ${Object.entries(cohort.legacyByYear).map(([y, v]) => `${y} ${nf(v.n)} / ${nf(v.mkd)} ден`).join(' · ') || '—'}`);
    console.log(`  cohort before, 2023–2025: ${Object.entries(cohort.yearsBefore).map(([y, v]) => `${y} ${nf(v.n)} / ${nf(v.mkd)} ден`).join(' · ')}`);
    console.table(Object.entries(cohort.remaining).sort((a, b) => b[1].n - a[1].n).map(([k, v]) => ({ 'MEX-only teleshop parcels that stay MEX-only': k, parcels: v.n, 'ден': nf(v.mkd) })));
  }
}

// ─── 9. the owner's sheet (Macedonian) ──────────────────────────────────────
function writeOwnerXlsx(path, { S, blast, cohort, plans, customers, runId, hash }) {
  const wb = XLSX.utils.book_new();
  const sheet = (name, aoa, widths) => {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    if (widths) ws['!cols'] = widths.map((w) => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, ws, name);
  };
  const created = S.byOutcome.created || { n: 0, mkd: 0 };
  const st = (k) => S.created.byStatus[k] || { n: 0, mkd: 0 };
  const excludedRows = Object.entries(S.byReason).filter(([k]) => k.startsWith('skipped:') || k.startsWith('conflict:')).sort((a, b) => b[1].n - a[1].n);
  const ov = [
    ['УВОЗ НА ТЕЛЕШОП КЛИЕНТИ И НАРАЧКИ (collabBox → CRM) — ПРОБА (ништо не е запишано)'],
    [`Направено: ${fmtSkopje(Date.now())} · документи од ${S.window.from} до ${S.window.to} · Нарачка in (10036) + Нарачка out (10050)`],
    [`Извор: collabBox заглавја (crawl 10.09.2026) + регистар на комитенти + MEX пратки (двете сметки) + CRM. MEX покриеност од ${S.mexFrom}.`],
    runId ? [`Проба бр. (run id): ${runId} · контролен хеш: ${hash.slice(0, 16)}…`] : ['Проба без запишан run id (--record го запишува пред примена).'],
    [],
    ['ШТО БИ СЕ СЛУЧИЛО', 'Документи', 'Денари', 'Евра'],
    ['Нови нарачки (вкупно)', created.n, Math.round(created.mkd), Math.round(created.mkd / T.MKD_PER_EUR)],
    ['  од нив: Платена — MEX потврдено (доставена)', st('paid|mex').n, Math.round(st('paid|mex').mkd), Math.round(st('paid|mex').mkd / T.MKD_PER_EUR)],
    ['  од нив: Платена — пред MEX, правило 12.08 (НЕ е MEX-потврдено)', st('paid|legacy_import').n, Math.round(st('paid|legacy_import').mkd), Math.round(st('paid|legacy_import').mkd / T.MKD_PER_EUR)],
    ['  од нив: Вратена (MEX 7)', st('returned|').n, Math.round(st('returned|').mkd), Math.round(st('returned|').mkd / T.MKD_PER_EUR)],
    ['  од нив: Кај курир', st('shipped|').n, Math.round(st('shipped|').mkd), Math.round(st('shipped|').mkd / T.MKD_PER_EUR)],
    ['  од нив: За пакување (само со --confirm-awaiting; инаку се чека пратката)', st('confirmed|').n, Math.round(st('confirmed|').mkd), Math.round(st('confirmed|').mkd / T.MKD_PER_EUR)],
    ['Веќе постојат во CRM (не се дуплираат)', (S.byOutcome.exists?.n || 0) + (S.byOutcome.enriched?.n || 0), Math.round((S.byOutcome.exists?.mkd || 0) + (S.byOutcome.enriched?.mkd || 0)), ''],
    ['Конфликти — пратката/продажбата ја има друга нарачка (не се креира ништо)', S.byOutcome.conflict?.n || 0, Math.round(S.byOutcome.conflict?.mkd || 0), ''],
    ['Исклучени (не се продажби / ѓубре / без телефон …)', S.byOutcome.skipped?.n || 0, Math.round(S.byOutcome.skipped?.mkd || 0), ''],
    [],
    ['КЛИЕНТИ', 'Телефони'],
    ['Нови клиенти (телефонот го нема во CRM)', S.phones.new],
    ['Постоечки CRM клиенти (иста последни 8 цифри — се спојуваат, не се дуплираат)', S.phones.existing],
    ['Постоечки, но CRM го чува бројот во неисправен формат (се користи истиот — за поправка посебно)', S.phones.existing_noncanonical],
    ['Профили на клиенти: нови / дополнети само празни полиња', `${S.profiles.inserted} / ${S.profiles.filled}`],
    [],
    ['ПРЕДИКЦИСКИ ЛИСТИ (проценка)', ''],
  ];
  if (S.segments) {
    const s = S.segments;
    ov.push(['Телефони што се менуваат', s.phones], ['  нови во листите', s.new_phones], ['  постоечки', s.existing_phones],
      ['Членства вкупно сега → потоа', `${s.members_now} → ${s.members_projected}`],
      ['Излегуваат од Trash List (платиле телешоп ПОСЛЕ ѓубрето — правило 06.08)', s.released_from_trash],
      ['Влегуваат во NEWCOMERS (купиле во последните 21 ден)', s.into_newcomers],
      ['Доделени членови што менуваат листа', s.assigned_moving],
      ['Точност на пресметката (огледало на моторот vs денешни членства)', `${s.mirror_fidelity}%`]);
  }
  if (S.cohort) {
    ov.push([], ['ИНСАЈТИ (кохорта) — проверка', ''],
      ['01–27.09: продажби / денари пред → потоа', `${S.cohort.sep.before.n} / ${Math.round(S.cohort.sep.before.mkd)} → ${S.cohort.sep.after.n} / ${Math.round(S.cohort.sep.after.mkd)}`],
      ['MEX-пратки без нарачка што стануваат collabBox нарачки (ист износ)', `${S.cohort.moved.n} / ${Math.round(S.cohort.moved.mkd)} ден`],
      ['  од нив менуваат месец (ден на документ ≠ ден на пратка)', `${S.cohort.moved.shiftedMonth} / ${Math.round(S.cohort.moved.shiftedMonthMkd)} ден`]);
    for (const [y, v] of Object.entries(S.cohort.legacyByYear)) ov.push([`Нови пари пред 2026 — ${y} (пред MEX, правило 12.08)`, `${v.n} нарачки / ${Math.round(v.mkd)} ден`]);
  }
  if (S.scopes?.length) {
    ov.push([], ['ОПСЕГ — ИЗБОР', 'Нарачки', 'Денари', 'од тоа пред MEX (ден)', 'Нови телефони', 'Постоечки', 'Членства во листи потоа', 'Излегуваат од Trash List']);
    for (const x of S.scopes) ov.push([`${x.key}: ${x.label}`, x.orders, Math.round(x.mkd), Math.round(x.basis.paid_legacy_import?.mkd || 0), x.new_phones, x.existing_phones, x.members_projected, x.released_from_trash]);
  }
  const mexPaid = st('paid|mex').n, mexRet = st('returned|').n;
  const retPct = mexPaid + mexRet ? Math.round((1000 * mexRet) / (mexPaid + mexRet)) / 10 : 0;
  ov.push([], ['ОДЛУКИ ЗА СОПСТВЕНИКОТ', ''],
    ['1. Опсег: A (само MEX период, сè потврдено), B (цела 2026) или C (цела историја 2023–2026)? Препорака: A веднаш, B/C по одлука.', ''],
    [`2. Пред MEX = „платена“ по правилото од 12.08. Во MEX периодот ${retPct}% од телешоп пратките се вратени — толку „платени“ пред MEX веројатно се враќања. Во ред?`, ''],
    ['3. Vraboten = Да: на стариот регистар (шифра < 40.000) е стара ознака, не вработен — 426 редовни купувачи СЕ увезуваат; прескокнати се вистинските вработени и операторските сметки. Потврда?', ''],
    [`4. Одлука 28.09: „Не се јавувај“ комитентите СЕ увезуваат со нарачките и одат во Корпа (trash „other“, белешка „Не се јавувај (collabBox)“); починатите НЕ се увезуваат; постоечките CRM клиенти добиваат иста ознака (починати: „Починат/а – не се јавувај (collabBox)“). Ознаки: ${S.bans?.markers ?? 0}.`, ''],
    [`4б. Сторно: ${S.stornos?.n ?? 0} сторно документи не се увезуваат; ${S.stornos?.paired ?? 0} оригинали што тие ги поништуваат се исклучени (reversed_by_storno). Повторени броеви на документ: ${S.reused ?? 0} — не се увезуваат.`, ''],
    ['5. Дупликати со AlterCPA 2025 (испратени како „Нарачка in“) — не се креираат; предлог: цената на AlterCPA нарачката да се поправи од документот (посебна поправка).', ''],
    ['6. Конфликти (пратката ја држи друга нарачка) — остануваат како што се (одлука 28.09).', ''],
    [`7. ${S.mislabelled?.n ?? 0} постоечки collabBox нарачки водени како „телешоп“ се всушност LEADS-OUT (10114) / LEADS (10111) документи во серија 9102 — предлог: изворот да се поправи (опција --relabel-source, со белешка и запис за враќање).`, ''],
    ['8. Ставки (производи) се повлечени за 2023–2026: 2026 мапира 99,4 %, 2023–2025 94,9 % од вредноста на каталогот; немапираните ставки остануваат со името од collabBox, без производ — ништо не се измислува.', '']);
  sheet('Преглед', ov, [95, 14, 16, 12]);

  const yt = [['Година', 'Тип', 'Документи', 'Денари', 'Нови нарачки', 'Денари (нови)', 'Платена MEX', 'Платена пред MEX', 'Вратена', 'Кај курир', 'За пакување', 'Веќе постојат', 'Конфликт', 'Исклучени', 'Денари (исклучени)']];
  for (const r of Object.values(S.byYearType).sort((a, b) => a.year.localeCompare(b.year) || a.type.localeCompare(b.type))) {
    yt.push([r.year, r.type, r.docs, Math.round(r.docs_mkd), r.created, Math.round(r.created_mkd), r.paid_mex, r.paid_legacy, r.returned, r.shipped, r.confirmed, r.exists, r.conflict, r.skipped, Math.round(r.skipped_mkd)]);
  }
  sheet('По година и тип', yt, [8, 12, 11, 14, 12, 14, 11, 14, 9, 9, 11, 12, 9, 10, 16]);

  const ex = [['Исход', 'Причина', 'Документи', 'Денари']];
  for (const [k, v] of excludedRows) { const cut = k.indexOf(':'); const o = k.slice(0, cut), r = k.slice(cut + 1); ex.push([REASON_MK[o] || o, reasonMk(r), v.n, Math.round(v.mkd)]); }
  sheet('Исклучени и конфликти', ex, [26, 80, 11, 14]);

  const money = [['Година', 'Статус', 'Основа', 'Нарачки', 'Денари', 'Евра']];
  const byYS = {};
  for (const p of plans) if (p.outcome === 'created') bump(byYS, `${p.year}|${p.status}|${p.basis || ''}`, 1, p.amount);
  for (const [k, v] of Object.entries(byYS).sort()) { const [y, s, b] = k.split('|'); money.push([y, STATUS_MK[s] || s, BASIS_MK[b] || '—', v.n, Math.round(v.mkd), Math.round(v.mkd / T.MKD_PER_EUR)]); }
  sheet('Пари по статус', money, [8, 14, 40, 10, 14, 12]);

  const cu = [['Комитенти по исход', 'Број']];
  for (const [k, v] of Object.entries(S.customers).sort((a, b) => b[1].n - a[1].n)) {
    const cut = k.indexOf(':');
    const o = cut < 0 ? k : k.slice(0, cut);
    let r = cut < 0 ? '' : k.slice(cut + 1);
    if (r.startsWith('no_new_order:')) r = `нема нова нарачка — ${reasonMk(r.slice(13))}`;
    const om = { new: 'Нов клиент', existing: 'Постоечки клиент', existing_noncanonical: 'Постоечки (неисправен формат на бројот во CRM)', skipped: 'Не се увезува' }[o] || o;
    cu.push([`${om}${r ? ' — ' + (r.startsWith('нема нова') ? r : reasonMk(['employee', 'company', 'deceased', 'do_not_contact', 'wrong_number', 'test'].includes(r) ? `komitent_${r}` : r)) : ''}`, v.n]);
  }
  sheet('Клиенти', cu, [90, 10]);

  if (blast) {
    const ls = [['Листа', 'Сега', 'Промена', 'Потоа']];
    for (const l of blast.lists) ls.push([l.list, l.now, l.change, l.projected]);
    ls.push([], ['Најчести преминувања', 'Телефони']);
    for (const t of blast.topTransitions) ls.push([t.transition, t.phones]);
    sheet('Предикциски листи', ls, [60, 10, 10, 10]);
  }
  if (cohort) {
    const co = [['Месец', 'Пред (ден)', 'Потоа (ден)', 'Разлика', 'Продажби пред', 'Продажби потоа', 'MEX-пратки телешоп без нарачка — пред', '… потоа', 'collabBox телешоп — потоа', 'од тоа пред MEX (legacy)']];
    for (const m of cohort.months) co.push([m.month, Math.round(m.before_mkd), Math.round(m.after_mkd), Math.round(m.after_mkd - m.before_mkd), m.before_n, m.after_n, Math.round(m.mex_teleshop_before_mkd), Math.round(m.mex_teleshop_after_mkd), Math.round(m.collabbox_teleshop_after_mkd), Math.round(m.legacy_after_mkd)]);
    const mexEra = cohort.months.filter((m) => m.month >= '2026-03');
    const net = mexEra.reduce((t, m) => t + (m.after_mkd - m.before_mkd - m.legacy_after_mkd), 0);
    co.push([], [`Март–септември без додадените пред-MEX пари: вкупно ${Math.round(net).toLocaleString('de-DE')} ден — разликите по месец се само поместување (продажбата се брои на денот на документот, а не на денот кога пратката е регистрирана кај MEX, обично 1–3 дена подоцна).`]);
    co.push(['01–27.09: продажби / ден пред → потоа', `${cohort.sep.before.n} / ${Math.round(cohort.sep.before.mkd)} → ${cohort.sep.after.n} / ${Math.round(cohort.sep.after.mkd)}`]);
    co.push([], ['Години пред 2026', 'Кохорта сега (ден)', 'Додадено пред MEX (ден)', 'Нарачки додадени']);
    for (const y of [...new Set([...Object.keys(cohort.yearsBefore), ...Object.keys(cohort.legacyByYear)])].sort()) co.push([y, Math.round(cohort.yearsBefore[y]?.mkd || 0), Math.round(cohort.legacyByYear[y]?.mkd || 0), cohort.legacyByYear[y]?.n || 0]);
    co.push([], ['MEX-пратки телешоп што остануваат без нарачка', 'Пратки', 'Денари']);
    for (const [k, v] of Object.entries(cohort.remaining).sort((a, b) => b[1].n - a[1].n)) co.push([k, v.n, Math.round(v.mkd)]);
    sheet('Инсајти 2026', co, [12, 14, 14, 12, 12, 12, 22, 14, 18, 16]);
  }
  const au = [['Автор (collabBox)', 'Нови нарачки', 'Денари', 'Поврзан продавач во CRM']];
  for (const a of Object.values(S.authors).sort((x, y) => y.docs - x.docs)) au.push([a.author, a.docs, Math.round(a.mkd), a.mapped || '— (нема; останува само името)']);
  sheet('Автори', au, [34, 12, 14, 34]);

  const cf = [['Документ', 'Датум', 'Износ (ден)', 'Причина', 'Нарачка што ја држи']];
  for (const p of plans.filter((x) => x.outcome === 'conflict').slice(0, 5000)) cf.push([p.doc_number, p.day, p.amount, reasonMk(p.reason), p.relatedDisplay || p.related || '']);
  sheet('Конфликти', cf, [24, 12, 12, 60, 16]);

  mkdirSync(join(path, '..'), { recursive: true });
  XLSX.writeFile(wb, path);
  return path;
}

// ─── 10. apply ──────────────────────────────────────────────────────────────
export function buildCreateChunkSql({ runId, chunk }) {
  const vals = chunk.map((p) => `(${[
    q(p.doc_number), q(p.doc.doc_id), q(p.type_id), q(p.series), `${q(p.doc.doc_at)}::timestamptz`, q(p.doc.komitent_id), q(p.author),
    p.amount, p.price, q(p.phone8), q(p.phone_src), q(p.phone), q((p.name || p.k.name).slice(0, 200)), q((p.city || p.k.city || '').slice(0, 120)), q((p.k.address || '').slice(0, 600)),
    q(p.status), q(p.basis), `${q(p.paid_at)}::timestamptz`, `${q(p.shipped_at)}::timestamptz`, `${q(p.returned_at)}::timestamptz`,
    q(p.tracking), p.remember_tracking ? 'true' : 'false', p.parcel ? p.parcel.status_id : 'NULL', p.parcel ? (p.parcel.cod_mkd ?? 'NULL') : 'NULL',
    qTextArray(p.flags), q(p.doc.source), q(p.product_name), p.product_id ? qUuid(p.product_id) : 'NULL::uuid', p.qty, qJson(p.items || []), q(p.reason), q(p.match),
  ].join(', ')})`);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.defer_segments = 'on';
set local statement_timeout = '180s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _p (
  doc text primary key, doc_id text, type_id text, series text, doc_at timestamptz, komitent text, author text,
  amount numeric, price numeric, phone8 text, phone_src text, phone text, name text, city text, address text,
  status text, basis text, paid_at timestamptz, shipped_at timestamptz, returned_at timestamptz,
  tracking text, remember boolean, exp_status int, exp_cod int, flags text[], src text,
  product_name text, product_id uuid, qty int, items jsonb, reason text, match text
) on commit drop;
insert into _p values
${vals.join(',\n')};

-- every parcel of the chunk, locked: a concurrent linker waits for the commit
select count(*) from (select 1 from public.mex_parcels where tracking_id in (select doc from _p) for update) l;

-- only documents still exactly as the dry run saw them
create temp table _ok on commit drop as
select p.* from _p p
 where not exists (select 1 from public.orders o where o.external_source = 'collabbox' and o.external_order_id = p.doc)
   and not exists (select 1 from public.orders o where o.mex_tracking_id = p.doc)
   and (case when p.tracking is not null
             then exists (select 1 from public.mex_parcels m where m.tracking_id = p.tracking and m.order_id is null
                            and m.status_id is not distinct from p.exp_status and m.cod_mkd is not distinct from p.exp_cod)
             else not exists (select 1 from public.mex_parcels m where m.tracking_id = p.doc) end);

create temp table _new (id uuid, external_order_id text, display_id text, status text, paid_basis text,
  sale_source text, sale_source_detail text, sold_via text, confirmed_by_name text, confirmed_by_agent_id uuid, assigned_agent_id uuid) on commit drop;
with ins as (
  insert into public.orders (product_id, product_name, customer_name, customer_phone, customer_city, customer_address,
         price, quantity, status, source_type, external_source, external_order_id, delivery_type,
         created_at, confirmed_at, sold_at, sold_via, sold_by_ext, sold_by_person_id,
         mex_tracking_id, paid_at, paid_basis, shipped_at, returned_at)
  select p.product_id, p.product_name, p.name, p.phone, coalesce(p.city, ''), coalesce(p.address, ''),
         p.price, greatest(p.qty, 1), p.status::public.order_status, 'import', 'collabbox', p.doc, 'home',
         p.doc_at, p.doc_at, p.doc_at, 'collabbox', p.author,
         (select i.person_id from public.sales_person_identities i
           where p.author is not null and i.account_id is null and i.value = p.author
             and i.kind in ('collabbox_author', 'order_name')
           order by (i.kind = 'collabbox_author') desc, i.created_at limit 1),
         case when p.tracking is not null or p.remember then p.doc end,
         p.paid_at, p.basis, p.shipped_at, p.returned_at
    from _ok p
   order by p.doc_at, p.doc
  on conflict (external_source, external_order_id) where external_order_id is not null do nothing
  returning id, external_order_id, display_id, status::text as status, paid_basis, sale_source, sale_source_detail,
            sold_via, confirmed_by_name, confirmed_by_agent_id, assigned_agent_id
)
insert into _new select * from ins;

insert into public.order_items (order_id, product_id, product_name, quantity, price_per_unit, total_price, created_at)
select n.id, nullif(x->>'product_id', '')::uuid, left(coalesce(nullif(x->>'name', ''), '—'), 300),
       greatest((x->>'qty')::int, 1), (x->>'ppu')::numeric, (x->>'total')::numeric, p.doc_at
  from _new n join _ok p on p.doc = n.external_order_id
  cross join lateral jsonb_array_elements(p.items) x;

create temp table _links on commit drop as
select n.id, n.external_order_id as tr, public.mex_link_parcel(n.external_order_id, n.id, 'collabbox_import', false) as res
  from _new n join _ok p on p.doc = n.external_order_id
 where p.tracking is not null
 order by n.external_order_id;

do $chk$
declare bad text; n int;
begin
  select string_agg(tr || ' → ' || coalesce(res, 'null'), ', ') into bad from _links where res is null or res not in ('linked', 'already');
  if bad is not null then raise exception 'teleshop-import: mex_link_parcel refused: %', bad; end if;
  select count(*) into n from _new x join _ok p on p.doc = x.external_order_id
   where x.status <> p.status or x.paid_basis is distinct from p.basis
      -- departments (20260942000700): 9100 lead in stays collabbox/teleshop; 9102 lead out is
      -- "Телешоп – Lead out" (elyon_crm/collabbox_out), or AlterCPA when an AlterCPA-team agent booked it
      or not ((x.sale_source = 'collabbox' and x.sale_source_detail = 'teleshop' and p.series <> '9102')
           or (p.series = '9102' and ((x.sale_source = 'elyon_crm' and x.sale_source_detail = 'collabbox_out')
                                   or (x.sale_source = 'altercpa' and x.sale_source_detail = 'team_collabbox_out'))));
  if n > 0 then raise exception 'teleshop-import: % orders did not keep their planned status / basis / source', n; end if;
  select count(*) into n from _new x
   where x.sold_via is distinct from 'collabbox' or x.confirmed_by_name is not null
      or x.confirmed_by_agent_id is not null or x.assigned_agent_id is not null;
  if n > 0 then raise exception 'teleshop-import: % orders carry an agent-facing identity (must be sold_* only)', n; end if;
end $chk$;

insert into public.teleshop_import_documents as d (doc_number, doc_id, doc_type_id, series, doc_at, komitent_id, author, amount_mkd, price_eur,
       phone8, phone_source, customer_phone, outcome, reason, planned_status, paid_basis, tracking_id, parcel_status_id, parcel_cod_mkd,
       order_id, related_order_id, flags, source, run_id, first_run_id, created_by_run)
select p.doc, p.doc_id, p.type_id, p.series, p.doc_at, p.komitent, p.author, p.amount, p.price,
       p.phone8, p.phone_src, p.phone,
       case when n.id is not null then 'created' when k.doc is not null then 'exists' else 'skipped' end,
       case when n.id is not null then p.reason when k.doc is not null then 'created_concurrently' else 'moved_since_dry_run' end,
       p.status, p.basis, coalesce(p.tracking, case when p.remember then p.doc end), p.exp_status, p.exp_cod,
       n.id, null, array_append(p.flags, 'match:' || coalesce(p.match, '?')), p.src, ${qUuid(runId)}, ${qUuid(runId)}, case when n.id is not null then ${qUuid(runId)} end
  from _p p left join _ok k on k.doc = p.doc left join _new n on n.external_order_id = p.doc
on conflict (doc_number) do update set
       doc_id = excluded.doc_id, doc_type_id = excluded.doc_type_id, series = excluded.series, doc_at = excluded.doc_at,
       komitent_id = excluded.komitent_id, author = excluded.author, amount_mkd = excluded.amount_mkd, price_eur = excluded.price_eur,
       phone8 = excluded.phone8, phone_source = excluded.phone_source, customer_phone = excluded.customer_phone,
       outcome = excluded.outcome, reason = excluded.reason, planned_status = excluded.planned_status, paid_basis = excluded.paid_basis,
       tracking_id = excluded.tracking_id, parcel_status_id = excluded.parcel_status_id, parcel_cod_mkd = excluded.parcel_cod_mkd,
       order_id = coalesce(excluded.order_id, d.order_id), flags = excluded.flags, source = excluded.source, run_id = excluded.run_id,
       created_by_run = coalesce(d.created_by_run, excluded.created_by_run), rolled_back_at = null, updated_at = now()
 -- a document an earlier run CREATED keeps that row (a re-sent chunk must never relabel it)
 where d.outcome <> 'created' or d.rolled_back_at is not null or excluded.outcome = 'created';

select (select count(*) from _p)::int as planned, (select count(*) from _new)::int as applied, (select count(*) from _links)::int as links,
       (select coalesce(jsonb_agg(p.doc), '[]'::jsonb) from _p p where not exists (select 1 from _new n where n.external_order_id = p.doc)) as skipped;`;
}

export function buildLedgerChunkSql({ runId, chunk }) {
  const num = (v, t) => (v == null || v === '' || !Number.isFinite(Number(v)) ? `NULL::${t}` : `${Number(v)}::${t}`);
  const vals = chunk.map((p) => `(${[
    q(p.doc_number), q(p.doc.doc_id), q(p.type_id || '?'), q(p.series), p.doc.doc_at ? `${q(p.doc.doc_at)}::timestamptz` : 'NULL::timestamptz',
    q(p.doc.komitent_id), q(p.author ?? p.doc.author), num(p.amount, 'numeric'), num(p.price, 'numeric'), q(p.phone8), q(p.phone_src), q(p.phone),
    q(p.outcome), q(p.reason), q(p.status), q(p.basis), q(p.tracking),
    num(p.parcel?.status_id, 'int'), num(p.parcel?.cod_mkd, 'int'),
    ['exists', 'enriched'].includes(p.outcome) && isUuid(p.related) ? qUuid(p.related) : 'NULL::uuid',
    p.outcome === 'conflict' && isUuid(p.related) ? qUuid(p.related) : 'NULL::uuid', qTextArray(p.flags), q(p.doc.source),
  ].join(', ')})`);
  return `
set local statement_timeout = '120s';
insert into public.teleshop_import_documents as d (doc_number, doc_id, doc_type_id, series, doc_at, komitent_id, author, amount_mkd, price_eur,
       phone8, phone_source, customer_phone, outcome, reason, planned_status, paid_basis, tracking_id, parcel_status_id, parcel_cod_mkd,
       order_id, related_order_id, flags, source, run_id, first_run_id)
select v.*, ${qUuid(runId)}, ${qUuid(runId)} from (values
${vals.join(',\n')}
) as v(doc_number, doc_id, doc_type_id, series, doc_at, komitent_id, author, amount_mkd, price_eur, phone8, phone_source, customer_phone,
       outcome, reason, planned_status, paid_basis, tracking_id, parcel_status_id, parcel_cod_mkd, order_id, related_order_id, flags, source)
on conflict (doc_number) do update set
       outcome = excluded.outcome, reason = excluded.reason, related_order_id = excluded.related_order_id,
       order_id = coalesce(d.order_id, excluded.order_id), flags = excluded.flags, run_id = excluded.run_id,
       amount_mkd = excluded.amount_mkd, doc_at = excluded.doc_at, updated_at = now()
 where d.outcome <> 'created' or d.rolled_back_at is not null;
select ${chunk.length}::int as planned, ${chunk.length}::int as applied;`;
}

export function buildCustomersChunkSql({ runId, chunk }) {
  const vals = chunk.map((c) => `(${[
    q(c.komitent_id), q(c.name), q(c.phone8), q(c.phone_raw), q(c.phone_field), q(c.customer_phone), q(c.outcome), q(c.reason),
    c.docs, c.created_orders, q(c.primary ? c.profile_action : null), qJson(c.profile_before ?? null), c.primary ? 'true' : 'false',
    q((c.city || '').slice(0, 120)), q((c.address || '').slice(0, 600)),
  ].join(', ')})`);
  return `
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
create temp table _c (komitent text, name text, phone8 text, phone_raw text, phone_field text, phone text, outcome text, reason text,
  docs int, created int, profile_action text, profile_before jsonb, is_primary boolean, city text, street text) on commit drop;
insert into _c values
${vals.join(',\n')};

-- a new phone: a profile (insert-only)
create temp table _pi (phone text) on commit drop;
with ins as (
  insert into public.customer_profiles (phone, customer_name, city, street)
  select c.phone, nullif(c.name, '—'), nullif(c.city, ''), nullif(c.street, '')
    from _c c
   where c.is_primary and c.profile_action = 'inserted' and c.phone is not null
     and exists (select 1 from public.orders o where o.customer_phone = c.phone and o.external_source = 'collabbox')
  on conflict (phone) do nothing
  returning phone
) insert into _pi select phone from ins;

-- an existing profile: ONLY its empty fields (their old values kept for --rollback)
create temp table _pf on commit drop as
select cp.phone,
       -- per filled field: what it was and what the import wrote (--rollback restores a field only
       -- while it still holds what the import wrote — a later human edit is never undone)
       jsonb_strip_nulls(jsonb_build_object(
         'customer_name', case when coalesce(btrim(cp.customer_name), '') = '' and coalesce(c.name, '—') <> '—'
                               then jsonb_build_object('before', cp.customer_name, 'wrote', c.name) end,
         'city',          case when coalesce(btrim(cp.city), '') = '' and c.city <> ''
                               then jsonb_build_object('before', cp.city, 'wrote', c.city) end,
         'street',        case when coalesce(btrim(cp.street), '') = '' and c.street <> ''
                               then jsonb_build_object('before', cp.street, 'wrote', c.street) end)) as before
  from public.customer_profiles cp join _c c on c.phone = cp.phone
 where c.is_primary and c.profile_action = 'filled'
   and ((coalesce(btrim(cp.customer_name), '') = '' and coalesce(c.name, '—') <> '—')
     or (coalesce(btrim(cp.city), '') = '' and c.city <> '')
     or (coalesce(btrim(cp.street), '') = '' and c.street <> ''));
update public.customer_profiles cp
   set customer_name = case when coalesce(btrim(cp.customer_name), '') = '' and coalesce(c.name, '—') <> '—' then c.name else cp.customer_name end,
       city          = case when coalesce(btrim(cp.city), '') = '' and c.city <> '' then c.city else cp.city end,
       street        = case when coalesce(btrim(cp.street), '') = '' and c.street <> '' then c.street else cp.street end
  from _pf f join _c c on c.phone = f.phone and c.is_primary
 where cp.phone = f.phone;

insert into public.teleshop_import_customers as t (komitent_id, name, phone8, phone_raw, phone_field, customer_phone, outcome, reason,
       docs, created_orders, profile_action, profile_before, profile_run_id, run_id, first_run_id)
select c.komitent, c.name, c.phone8, c.phone_raw, c.phone_field, c.phone, c.outcome, c.reason, c.docs, c.created,
       case when not c.is_primary then null
            when exists (select 1 from _pi where _pi.phone = c.phone) then 'inserted'
            when exists (select 1 from _pf where _pf.phone = c.phone) then 'filled' else 'none' end,
       (select f.before from _pf f where f.phone = c.phone and c.is_primary),
       case when c.is_primary and (exists (select 1 from _pi where _pi.phone = c.phone) or exists (select 1 from _pf where _pf.phone = c.phone))
            then ${qUuid(runId)} end,
       ${qUuid(runId)}, ${qUuid(runId)}
  from _c c
on conflict (komitent_id) do update set
       name = excluded.name, phone8 = excluded.phone8, phone_raw = excluded.phone_raw, phone_field = excluded.phone_field,
       customer_phone = coalesce(excluded.customer_phone, t.customer_phone), outcome = excluded.outcome, reason = excluded.reason,
       docs = excluded.docs, created_orders = excluded.created_orders,
       -- the run that actually inserted / filled a profile owns it (its --rollback removes it)
       profile_action = case when excluded.profile_run_id is not null then excluded.profile_action else coalesce(t.profile_action, excluded.profile_action) end,
       profile_before = case when excluded.profile_run_id is not null then excluded.profile_before else coalesce(t.profile_before, excluded.profile_before) end,
       profile_run_id = coalesce(excluded.profile_run_id, t.profile_run_id),
       run_id = excluded.run_id, updated_at = now();

select (select count(*) from _c)::int as planned, (select count(*) from _c)::int as applied,
       (select count(*) from _pi)::int as profiles_inserted, (select count(*) from _pf)::int as profiles_filled;`;
}

async function runChunks(label, items, size, build) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  const st = { planned: 0, applied: 0, links: 0, skipped: [], failed: null, extra: {} };
  for (let i = 0; i < chunks.length; i++) {
    const a = await segmentRecomputeActivity();
    if (a.busy > 0) { st.failed = { chunk: i + 1, error: `${a.what} started — stopped before this chunk` }; console.log(yellow(`  stopped: ${st.failed.error}`)); break; }
    const t0 = Date.now();
    process.stdout.write(`  ${label} ${i + 1}/${chunks.length} (${chunks[i].length}) … `);
    try {
      const res = await sql(build(chunks[i]));
      const r = res[res.length - 1] || res[0];
      if (!r) throw new Error('no result row — check the ledger before resuming');
      st.planned += Number(r.planned || 0); st.applied += Number(r.applied || 0); st.links += Number(r.links || 0);
      for (const k of ['profiles_inserted', 'profiles_filled']) if (r[k] != null) inc(st.extra, k, Number(r[k]));
      if (Array.isArray(r.skipped)) st.skipped.push(...r.skipped);
      console.log(`${green('committed')} ${r.applied}/${r.planned}${Array.isArray(r.skipped) && r.skipped.length ? yellow(` (${r.skipped.length} moved since the dry run — left alone)`) : ''} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    } catch (e) {
      console.log(red('FAILED — rolled back'));
      st.failed = { chunk: i + 1, error: String(e.message || e).slice(0, 1500) };
      console.error(red(st.failed.error));
      break;
    }
  }
  return st;
}

async function requireImportSchema({ forApply }) {
  const [s] = await sqlRead(`select to_regclass('public.teleshop_import_documents') is not null as docs,
      to_regclass('public.teleshop_import_customers') is not null as cust,
      to_regclass('public.segment_recompute_queue') is not null as queue,
      to_regclass('public.data_repair_runs') is not null as runs,
      to_regprocedure('public.segment_recompute_drain(integer)') is not null as drain,
      to_regprocedure('public.mex_link_parcel(text,uuid,text,boolean)') is not null as link,
      (select position('defer_segments' in prosrc) > 0 from pg_proc where oid = 'public.trg_orders_recompute_segments'::regproc) as defer_gate`);
  const missing = Object.entries(s).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    const msg = `migration 20260942000300_teleshop_import_ledger.sql not applied (missing: ${missing.join(', ')})`;
    if (forApply) die(`${msg} — refusing to write.`);
    warn(`${msg} — fine for a dry run, BLOCKS --apply.`);
    return false;
  }
  ok('ledger tables, segment queue and the defer_segments gate are live');
  return true;
}

/**
 * Optional (--banned-as-trash / --trash-banned-existing): ONE trashed disposition row per banned
 * phone — status trashed, trash_reason 'other' (a PERMANENT class in engine v3.7-mk), the ban in
 * trash_reason_notes, trashed_at = now(), price 0, source_type 'manual' → sale_source_detail
 * 'disposition' (never a sale, excluded from every cohort). Sticky trash then removes the phone
 * from every calling band and holds it in the Trash List; the ONLY release is a PAID order dated
 * after the marker (engine rule) — no imported order is (they are all older). Idempotent on
 * (external_source 'teleshop_import', external_order_id 'ban:<phone>').
 */
export function buildMarkerChunkSql({ runId, rows }) {
  const vals = rows.map((m) => `(${q(m.phone)}, ${q(String(m.name || '—').slice(0, 200))}, ${q(m.ban)}, ${q(BAN_NOTE[m.ban])}, ${q(m.source)}, ${q(m.komitent_id)})`).join(',\n');
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.defer_segments = 'on';
set local statement_timeout = '120s';
create temp table _m (phone text primary key, name text, ban text, note text, source text, komitent text) on commit drop;
insert into _m values
${vals};
create temp table _mi (id uuid, phone text) on commit drop;
with ins as (
  insert into public.orders (product_name, customer_name, customer_phone, price, quantity, status, source_type,
         external_source, external_order_id, delivery_type, created_at, trashed_at, trash_reason, trash_reason_notes)
  select 'Trashed — ' || m.note, m.name, m.phone, 0, 1, 'trashed', 'manual',
         'teleshop_import', 'ban:' || m.phone, 'home', now(), now(), 'other', m.note
    from _m m
  on conflict (external_source, external_order_id) where external_order_id is not null do nothing
  returning id, customer_phone
) insert into _mi select id, customer_phone from ins;
do $chk$
declare n int;
begin
  select count(*) into n from _mi x join public.orders o on o.id = x.id
   where o.status <> 'trashed' or o.trash_reason is distinct from 'other' or o.sale_source_detail is distinct from 'disposition';
  if n > 0 then raise exception 'teleshop-import: % ban markers did not land as trashed / other / disposition', n; end if;
end $chk$;
insert into public.data_repair_rows (run_id, order_id, rule, before, after, evidence)
select ${qUuid(runId)}, x.id, 'teleshop-ban-trash', null, jsonb_build_object('status', 'trashed', 'trash_reason', 'other'),
       jsonb_build_object('phone', m.phone, 'ban', m.ban, 'source', m.source, 'komitent', m.komitent)
  from _mi x join _m m on m.phone = x.phone;
select (select count(*) from _m)::int as planned, (select count(*) from _mi)::int as applied;`;
}

/** Links an existing collabBox order to its own parcel (no force); before / after in data_repair_rows 'teleshop-link'. */
export function buildLinkChunkSql({ runId, rows }) {
  const vals = rows.map((r) => `(${qUuid(r.order_id)}, ${q(r.doc)})`).join(',\n');
  const R = qUuid(runId);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.defer_segments = 'on';
set local statement_timeout = '120s';
create temp table _l (order_id uuid primary key, doc text) on commit drop;
insert into _l values
${vals};
insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${R}, o.id, 'teleshop-link',
       jsonb_build_object('mex_tracking_id', o.mex_tracking_id, 'mex_account', o.mex_account, 'mex_status_id', o.mex_status_id,
         'mex_cod_mkd', o.mex_cod_mkd, 'mex_delivered_at', o.mex_delivered_at, 'mex_returned_at', o.mex_returned_at, 'mex_last_update_at', o.mex_last_update_at),
       jsonb_build_object('doc', l.doc)
  from _l l join public.orders o on o.id = l.order_id
 where exists (select 1 from public.mex_parcels m where m.tracking_id = l.doc and m.order_id is null)
   and (o.mex_tracking_id is null or o.mex_tracking_id = l.doc)
   and not exists (select 1 from public.data_repair_rows r where r.run_id = ${R} and r.rule = 'teleshop-link' and r.order_id = l.order_id);
create temp table _lr on commit drop as
select l.order_id, l.doc, public.mex_link_parcel(l.doc, l.order_id, 'collabbox_import', false) as res
  from _l l join public.data_repair_rows r on r.run_id = ${R} and r.rule = 'teleshop-link' and r.order_id = l.order_id and r.after is null;
delete from public.data_repair_rows r using _lr x
 where r.run_id = ${R} and r.rule = 'teleshop-link' and r.order_id = x.order_id and r.after is null and x.res <> 'linked';
update public.data_repair_rows r set after = jsonb_build_object('mex_tracking_id', o.mex_tracking_id, 'res', x.res)
  from _lr x join public.orders o on o.id = x.order_id
 where r.run_id = ${R} and r.rule = 'teleshop-link' and r.order_id = x.order_id and r.after is null;
select (select count(*) from _l)::int as planned, (select count(*) from _lr where res = 'linked')::int as applied;`;
}

/** Optional (--relabel-source): a mislabelled 'teleshop' order gets the detail of its real document type. */
export function buildRelabelSql({ runId, rows }) {
  const vals = rows.map((r) => `(${qUuid(r.order_id)}, ${q(r.target)}, ${q(r.doc_number)}, ${q(r.doc_type)})`).join(',\n');
  return `
set local elyon.allow_source_change = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.bulk_repair = 'on';
set local statement_timeout = '120s';
create temp table _rl (order_id uuid primary key, target text, doc text, doc_type text) on commit drop;
insert into _rl values
${vals};
insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, o.id, 'teleshop-relabel', jsonb_build_object('sale_source_detail', o.sale_source_detail),
       jsonb_build_object('doc', r.doc, 'doc_type', r.doc_type, 'target', r.target)
  from public.orders o join _rl r on r.order_id = o.id
 where o.sale_source = 'collabbox' and o.sale_source_detail = 'teleshop';
update public.orders o set sale_source_detail = r.target
  from _rl r where o.id = r.order_id and o.sale_source = 'collabbox' and o.sale_source_detail = 'teleshop';
insert into public.order_notes (order_id, text, author_id, author_name)
select r.order_id, format('collabBox: документот %s е тип %s, не телешоп — изворот е поправен teleshop → %s (увоз на телешоп, 28.09.2026).', r.doc, r.doc_type, r.target),
       null, ${q(ACTOR_NAME)}
  from _rl r join public.data_repair_rows d on d.order_id = r.order_id and d.run_id = ${qUuid(runId)} and d.rule = 'teleshop-relabel' and d.after is null;
update public.data_repair_rows d set after = jsonb_build_object('sale_source_detail', o.sale_source_detail)
  from public.orders o where d.run_id = ${qUuid(runId)} and d.rule = 'teleshop-relabel' and d.order_id = o.id and d.after is null;
select (select count(*) from _rl)::int as planned,
       (select count(*) from public.data_repair_rows where run_id = ${qUuid(runId)} and rule = 'teleshop-relabel')::int as applied;`;
}

// ─── 11. rollback + drain ───────────────────────────────────────────────────
/** One rollback transaction: unlink the parcels, delete the run's orders, drop the profiles it inserted. */
export function buildRollbackChunkSql({ runId, ids }) {
  const chunk = ids;
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.defer_segments = 'on';
set local statement_timeout = '180s';
create temp table _r on commit drop as select unnest(${`ARRAY[${chunk.map(qUuid).join(',')}]`}) as id;
update public.mex_parcels m set order_id = null, link_method = null, linked_at = null where m.order_id in (select id from _r);
create temp table _ph on commit drop as select distinct customer_phone as phone from public.orders where id in (select id from _r);
delete from public.orders o using _r where o.id = _r.id and o.external_source = 'collabbox';
-- the FK (ON DELETE SET NULL) already cleared order_id on the deleted orders' ledger rows
update public.teleshop_import_documents d set rolled_back_at = now(), updated_at = now()
 where d.created_by_run = ${qUuid(runId)} and d.order_id is null and d.rolled_back_at is null;
delete from public.customer_profiles cp using _ph
 where cp.phone = _ph.phone and not exists (select 1 from public.orders o where o.customer_phone = cp.phone)
   and exists (select 1 from public.teleshop_import_customers t where t.customer_phone = cp.phone and t.profile_action = 'inserted' and t.profile_run_id = ${qUuid(runId)});
select (select count(*) from _r)::int as planned, (select count(*) from _r)::int as applied;`;
}

/** The rollback steps, in order (markers go first so their phones' profiles can go with the orders). */
export const ROLLBACK_ORDER = Object.freeze(['markers', 'orders', 'links', 'relabels', 'profiles']);
export function buildRollbackMarkersSql({ runId, ids }) {
  return `
set local elyon.bulk_repair = 'on';
set local elyon.defer_segments = 'on';
delete from public.orders o where o.id = any(ARRAY[${ids.map(qUuid).join(',')}]::uuid[]) and o.external_source = 'teleshop_import';
update public.data_repair_rows r set after = coalesce(r.after, '{}'::jsonb) || '{"rolled_back": true}'::jsonb
 where r.run_id = ${qUuid(runId)} and r.rule = 'teleshop-ban-trash' and r.order_id = any(ARRAY[${ids.map(qUuid).join(',')}]::uuid[]);
select ${ids.length}::int as planned, ${ids.length}::int as applied;`;
}
export function buildRollbackLinksSql({ runId }) {
  const R = qUuid(runId);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.defer_segments = 'on';
create temp table _lk on commit drop as
select r.order_id, r.evidence->>'doc' as doc, r.before from public.data_repair_rows r
 where r.run_id = ${R} and r.rule = 'teleshop-link' and r.after ? 'res' and not (r.after ? 'rolled_back');
update public.mex_parcels m set order_id = null, link_method = null, linked_at = null
  from _lk k where m.tracking_id = k.doc and m.order_id = k.order_id and m.link_method = 'collabbox_import';
update public.orders o
   set mex_tracking_id = k.before->>'mex_tracking_id', mex_account = k.before->>'mex_account',
       mex_status_id = (k.before->>'mex_status_id')::int, mex_cod_mkd = (k.before->>'mex_cod_mkd')::int,
       mex_delivered_at = (k.before->>'mex_delivered_at')::timestamptz, mex_returned_at = (k.before->>'mex_returned_at')::timestamptz,
       mex_last_update_at = (k.before->>'mex_last_update_at')::timestamptz
  from _lk k where o.id = k.order_id and o.mex_tracking_id = k.doc;
update public.data_repair_rows r set after = r.after || '{"rolled_back": true}'::jsonb
  from _lk k where r.run_id = ${R} and r.rule = 'teleshop-link' and r.order_id = k.order_id;
select (select count(*) from _lk)::int as planned, (select count(*) from _lk)::int as applied;`;
}
export function buildRollbackRelabelSql({ runId }) {
  const R = qUuid(runId);
  return `
set local elyon.allow_source_change = 'on';
set local elyon.keep_updated_at = 'on';
create temp table _rv on commit drop as
select r.order_id, r.before->>'sale_source_detail' as was, r.after->>'sale_source_detail' as now from public.data_repair_rows r
 where r.run_id = ${R} and r.rule = 'teleshop-relabel' and r.after is not null and not (r.after ? 'rolled_back');
update public.orders o set sale_source_detail = v.was from _rv v where o.id = v.order_id and o.sale_source_detail = v.now;
delete from public.order_notes n using _rv v
 where n.order_id = v.order_id and n.author_name = ${q(ACTOR_NAME)} and n.text like 'collabBox: документот %изворот е поправен%';
update public.data_repair_rows r set after = r.after || '{"rolled_back": true}'::jsonb
  from _rv v where r.run_id = ${R} and r.rule = 'teleshop-relabel' and r.order_id = v.order_id;
select (select count(*) from _rv)::int as planned, (select count(*) from _rv)::int as applied;`;
}
export function buildRollbackProfilesSql({ runId }) {
  const R = qUuid(runId);
  return `
set local elyon.keep_updated_at = 'on';
-- filled fields back, only where they still hold what the run wrote (a later human edit stays)
update public.customer_profiles cp
   set customer_name = case when cp.customer_name is not distinct from t.profile_before->'customer_name'->>'wrote' then t.profile_before->'customer_name'->>'before' else cp.customer_name end,
       city          = case when cp.city is not distinct from t.profile_before->'city'->>'wrote' then t.profile_before->'city'->>'before' else cp.city end,
       street        = case when cp.street is not distinct from t.profile_before->'street'->>'wrote' then t.profile_before->'street'->>'before' else cp.street end
  from public.teleshop_import_customers t
 where t.profile_run_id = ${R} and t.profile_action = 'filled' and t.customer_phone = cp.phone;
-- profiles this run inserted whose phone has no order left (the per-chunk cleanup's safety net)
delete from public.customer_profiles cp using public.teleshop_import_customers t
 where t.profile_run_id = ${R} and t.profile_action = 'inserted' and t.customer_phone = cp.phone
   and not exists (select 1 from public.orders o where o.customer_phone = cp.phone);
update public.teleshop_import_customers t set profile_run_id = null, updated_at = now() where t.profile_run_id = ${R};
select 1::int as planned, 1::int as applied;`;
}

async function rollback({ runId, apply, chunkSize }) {
  const docs = await sqlRead(`select d.doc_number, d.order_id, o.display_id, o.status::text as status, o.customer_phone,
        (select count(*) from public.order_history h where h.order_id = d.order_id and h.changed_by is not null)::int as human_changes,
        (select count(*) from public.agent_payout_items a where a.order_id = d.order_id)::int as in_payout
      from public.teleshop_import_documents d join public.orders o on o.id = d.order_id
     where d.created_by_run = ${qUuid(runId)} and d.rolled_back_at is null
       and o.external_source = 'collabbox' and o.external_order_id = d.doc_number`);
  const held = docs.filter((d) => d.in_payout > 0);
  const touched = docs.filter((d) => d.human_changes > 0);
  // the optional steps of the same run: ban markers (deleted) and source relabels (reverted)
  const bans = await sqlRead(`select r.order_id from public.data_repair_rows r join public.orders o on o.id = r.order_id
     where r.run_id = ${qUuid(runId)} and r.rule = 'teleshop-ban-trash' and o.external_source = 'teleshop_import'`);
  const [{ n: linkN }] = await sqlRead(`select count(*)::int as n from public.data_repair_rows r where r.run_id = ${qUuid(runId)} and r.rule = 'teleshop-link' and r.after ? 'res'`);
  const relabels = await sqlRead(`select r.order_id, r.before->>'sale_source_detail' as was, r.after->>'sale_source_detail' as now
      from public.data_repair_rows r where r.run_id = ${qUuid(runId)} and r.rule = 'teleshop-relabel' and r.after is not null`);
  console.log(`  + ${bans.length} ban markers to delete (first) · ${linkN} parcel links to undo · ${relabels.length} source relabels to revert (+ their notes)`);
  console.log(`run ${runId}: ${nf(docs.length)} created orders still present · ${held.length} in an agent payout (kept) · ${touched.length} changed by a person since (deleted anyway, listed)`);
  const path = writeCsvFile(`rollback-${runId.slice(0, 8)}-${fileStamp()}.csv`, docs);
  ok(`list → ${path}`);
  if (!apply) { console.log('PREVIEW — nothing deleted. Add --apply (quiet window).'); return; }
  requireQuietWindow({ override: false });
  await requireNoSegmentRecompute('roll back');
  const ids = docs.filter((d) => !d.in_payout).map((d) => d.order_id);
  let st = { applied: 0, failed: null };
  for (const step of ROLLBACK_ORDER) {
    let r = null;
    if (step === 'markers' && bans.length) r = await runChunks('ban-markers', bans.map((b) => b.order_id), 500, (chunk) => buildRollbackMarkersSql({ runId, ids: chunk }));
    if (step === 'orders') { r = await runChunks('rollback', ids, chunkSize, (chunk) => buildRollbackChunkSql({ runId, ids: chunk })); st = r; }
    if (step === 'links') r = await runChunks('link-revert', [1], 1, () => buildRollbackLinksSql({ runId }));
    if (step === 'relabels' && relabels.length) r = await runChunks('relabel-revert', [1], 1, () => buildRollbackRelabelSql({ runId }));
    if (step === 'profiles') r = await runChunks('profiles', [1], 1, () => buildRollbackProfilesSql({ runId }));
    if (r?.failed) die(`rollback step ${step} stopped: ${r.failed.error} — re-run --rollback to continue.`);
  }
  console.log(`rolled back ${nf(st.applied)} orders${st.failed ? red(` — stopped: ${st.failed.error}`) : ''}. Now: --drain, then node scripts/engine-fixture-mk.mjs`);
}

async function drain(batch) {
  let total = 0;
  for (;;) {
    const a = await segmentRecomputeActivity();
    if (a.busy > 0) { warn(`${a.what} is running — stopping the drain (re-run later)`); break; }
    const [{ left }] = await sqlRead('select count(*)::int as "left" from public.segment_recompute_queue where failed_at is null');
    if (!left) break;
    const t0 = Date.now();
    const [r] = await sql(`set local statement_timeout = '600s'; select public.segment_recompute_drain(${Number(batch)}) as n;`);
    total += Number(r.n || 0);
    console.log(`  drained ${r.n} (${nf(left - r.n)} left) in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const [{ still }] = await sqlRead('select count(*)::int as "still" from public.segment_recompute_queue where failed_at is null');
    if (!r.n && still >= left) break;                       // nothing moved — never loop forever
  }
  const failed = await sqlRead('select phone, failed_at, last_error from public.segment_recompute_queue where failed_at is not null order by failed_at');
  if (failed.length) {
    warn(`${failed.length} phone(s) failed their recompute and were skipped (left in segment_recompute_queue with last_error):`);
    for (const f of failed.slice(0, 30)) console.log(`    ${f.phone}  ${String(f.last_error).slice(0, 160)}`);
    writeCsvFile(`drain-failures-${fileStamp()}.csv`, failed);
  }
  ok(`segment queue drained: ${nf(total)} phones recomputed${failed.length ? `, ${failed.length} failed (listed)` : ''}. Next: node scripts/engine-fixture-mk.mjs`);
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'record', 'rollback', 'drain', 'outside-quiet-window', 'no-cohort', 'no-segments', 'no-xlsx', 'vraboten-literal', 'no-helper-files', 'confirm-awaiting', 'relabel-source', 'banned-as-trash', 'trash-banned-existing', 'keep-storno-originals'],
    values: ['run', 'from', 'to', 'orders-dir', 'komitenti', 'fetch', 'actor', 'chunk', 'xlsx', 'mex-from', 'drain-batch', 'customers', 'items'],
  });
  mkGuard();
  await assertRemoteIsMk();
  const chunkSize = Math.max(1, Math.min(MAX_DOC_CHUNK, Number(args.chunk) || MAX_DOC_CHUNK));

  if (args.drain) { await requireImportSchema({ forApply: true }); await drain(Number(args['drain-batch']) || 2000); return; }
  if (args.rollback) {
    if (!isUuid(args.run)) die('--rollback needs --run <id>');
    await requireImportSchema({ forApply: true });
    await rollback({ runId: args.run, apply: !!args.apply, chunkSize });
    return;
  }

  const nowMs = Date.now();
  const today = T.skopjeDay(nowMs);
  const window = { from: args.from || '2023-01-01', to: args.to || today };
  for (const v of [window.from, window.to]) if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) die(`bad date ${v} (use YYYY-MM-DD)`);
  const mexFrom = args['mex-from'] || T.MEX_COVERAGE_FROM;
  const helper = (flag, file) => {
    if (args['no-helper-files']) return null;
    const path = args[flag] || join(OUT_DIR, file);
    if (!existsSync(path)) { if (args[flag]) die(`--${flag} ${path} not found`); return null; }
    const buf = readFileSync(path);
    return { path, sha: createHash('sha256').update(buf).digest('hex'), json: JSON.parse(buf.toString('utf8')) };
  };
  const custFile = helper('customers', 'customers-clean.json');
  const itemsFiles = (args['no-helper-files'] ? [] : (args.items ? String(args.items).split(',') : ['items-2026-summary.json', 'items-2023-2025-summary.json'].map((x) => join(OUT_DIR, x))))
    .filter((p) => { if (existsSync(p)) return true; if (args.items) die(`--items ${p} not found`); return false; })
    .map((path) => { const buf = readFileSync(path); return { path, sha: createHash('sha256').update(buf).digest('hex'), json: JSON.parse(buf.toString('utf8')) }; });
  const itemsFile = itemsFiles.length ? itemsFiles[0] : null;
  const options = { from: window.from, to: window.to, mexFrom, fetch: args.fetch || null, vrabotenLiteral: !!args['vraboten-literal'], confirmAwaiting: !!args['confirm-awaiting'], relabelSource: !!args['relabel-source'],
    bannedAsTrash: !!args['banned-as-trash'], trashBannedExisting: !!args['trash-banned-existing'], keepStornoOriginals: !!args['keep-storno-originals'],
    customers: custFile ? custFile.sha.slice(0, 16) : null, items: itemsFiles.map((x) => x.sha.slice(0, 16)).join(',') || null };

  const schemaOk = await requireImportSchema({ forApply: !!args.apply });
  if (args.apply) {
    if (!isUuid(args.run)) die('--apply needs --run <id> (from a --record dry run).');
    requireQuietWindow({ override: !!args['outside-quiet-window'] });
    await requireKeepUpdatedAt({ forApply: true });
    await requireNoSegmentRecompute('start');
  } else await requireKeepUpdatedAt({ forApply: false });

  console.log(bold('\nloading sources …'));
  const crawl = loadCrawl(args['orders-dir'] || DEFAULT_ORDERS_DIR);
  ok(`crawl: ${nf(crawl.docs.length)} teleshop headers; ${nf(crawl.otherTypeOf.size)} other-type doc numbers`);
  const fetchFiles = args.fetch ? String(args.fetch).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const fetched = fetchFiles.length ? loadFetch(fetchFiles) : { headers: [], items: new Map() };
  if (fetchFiles.length) ok(`fetch: ${nf(fetched.headers.length)} headers, line items for ${nf(fetched.items.size)} documents`);
  if (itemsFile) {
    fetched.itemHeaders = [];
    for (const itf of itemsFiles) {
      const before = fetched.itemHeaders.length;
      const m = T.adaptItemsSummary(itf.json, fetched.itemHeaders);
      for (const [doc, lines] of m) fetched.items.set(doc, lines);        // helper B's validated lines win
      ok(`items (helper B): lines for ${nf(m.size)} documents, ${nf(fetched.itemHeaders.length - before)} fresh headers ← ${itf.path}`);
    }
  } else warn('items-2026-summary.json not found — orders are planned WITHOUT line items (constant "no items" product)');
  const customersClean = custFile ? T.adaptCustomersClean(custFile.json) : null;
  if (customersClean) ok(`customers (helper A): ${nf(customersClean.size)} komitent verdicts ← ${custFile.path}`);
  else warn('customers-clean.json not found — interim customer rules (strict MK phone, employees, markers) are used');
  const komitenti = loadKomitenti(args.komitenti || DEFAULT_KOMITENTI);
  ok(`komitenti: ${nf(komitenti.size)}`);
  const db = await loadDb({ wantItems: fetched.items.size > 0 });

  console.log(bold('\nclassifying …'));
  const cls = classify({ crawl, fetched, komitenti, db, window, nowMs, mexFrom, vrabotenLiteral: !!args['vraboten-literal'], customersClean, confirmAwaiting: !!args['confirm-awaiting'],
    bannedAsTrash: !!args['banned-as-trash'], keepStornoOriginals: !!args['keep-storno-originals'] });
  const plans = cls.plans;
  for (const p of plans) if (p.related && cls.ordersById.get(p.related)) p.relatedDisplay = cls.ordersById.get(p.related).display_id;
  const customers = buildCustomers(plans, cls.kVerdict, cls.profileByPhone, cls.isCrmPhone);
  // ban markers: only where the phone would NOT already be held permanently by sticky trash
  const markers = [];
  {
    const rowsBy = new Map();
    const engRow = (o) => ({ status: o.status, created_at: toMs(o.created_at), price: Number(o.price) || 0, source_type: o.source_type, trash_reason: o.trash_reason, trashed_at: toMs(o.trashed_at) });
    for (const o of db.orders) if (o.customer_phone) (rowsBy.get(o.customer_phone) ?? rowsBy.set(o.customer_phone, []).get(o.customer_phone)).push(engRow(o));
    for (const p of plans) if (p.outcome === 'created') (rowsBy.get(p.phone) ?? rowsBy.set(p.phone, []).get(p.phone)).push({ status: p.status, created_at: toMs(p.doc.doc_at), price: p.price, source_type: 'import' });
    const want = [...(args['banned-as-trash'] ? cls.bannedPhones.values() : []), ...(args['trash-banned-existing'] ? cls.existingBanned : [])];
    const seen = new Set();
    for (const m of want) {
      if (seen.has(m.phone)) continue;
      seen.add(m.phone);
      const now = T.engineClassify(rowsBy.get(m.phone) || [], nowMs);
      if (now.perm) { m.already_trashed = true; continue; }
      markers.push(m);
    }
  }
  const relabel = args['relabel-source'] ? cls.mislabelled.filter((r) => r.target) : [];
  const relabelLine = (r) => `relabel|${r.order_id}|${r.target}`;
  const markerLine = (m) => `ban|${m.phone}|${m.ban}`;
  const lines = [...plans.map(planLine), ...relabel.map(relabelLine), ...markers.map(markerLine)];
  const hash = candidateHash(lines);

  // ── APPLY ────────────────────────────────────────────────────────────────
  if (args.apply) {
    const [run] = await sqlRead(`select id, key, dry_run, candidate_hash, summary, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
    if (!run || run.key !== KEY || !run.dry_run) die(`run ${args.run} is not a ${KEY} dry run.`);
    if (run.applied_at) die(`run ${args.run} was already applied at ${fmtSkopje(run.applied_at)}.`);
    if (canonicalJson(run.summary?.options ?? {}) !== canonicalJson(options)) die(`run ${args.run} was dry-run with options ${canonicalJson(run.summary?.options)}; pass the same flags.`);
    // a resumed run: documents this run already created come back as 'exists' — take their line from the ledger
    const done = await sqlRead(`select doc_number, outcome, reason, planned_status, paid_basis, customer_phone, price_eur::text as price_eur,
        tracking_id, parcel_status_id, parcel_cod_mkd from public.teleshop_import_documents where run_id = ${qUuid(args.run)} and outcome = 'created'`);
    const doneSet = new Set(done.map((d) => d.doc_number));
    const resumeCreated = new Map((await sqlRead(`select doc_number, customer_phone, flags from public.teleshop_import_documents
        where run_id = ${qUuid(args.run)} and outcome = 'created'`))
      .map((d) => [d.doc_number, { phone: d.customer_phone, match: (d.flags || []).find((x) => String(x).startsWith('match:'))?.slice(6) || 'new' }]));
    const doneLines = done.map((d) => [d.doc_number, 'created', d.reason, d.planned_status ?? '', d.paid_basis ?? '', d.customer_phone ?? '', d.price_eur != null ? eur2(d.price_eur) : '',
      d.planned_status === 'confirmed' ? '' : (d.tracking_id ?? ''), d.parcel_status_id ?? '', d.parcel_cod_mkd ?? '', ''].join('|'));
    // a relabel already applied by this run no longer classifies as mislabelled: keep its line
    const doneRelabel = await sqlRead(`select order_id, evidence->>'target' as target from public.data_repair_rows where run_id = ${qUuid(args.run)} and rule = 'teleshop-relabel'`);
    const doneRl = new Set(doneRelabel.map((r) => r.order_id));
    const combined = [...doneLines, ...plans.filter((p) => !doneSet.has(p.doc_number)).map(planLine),
      ...doneRelabel.map(relabelLine), ...relabel.filter((r) => !doneRl.has(r.order_id)).map(relabelLine)];
    // markers this run already wrote are permanent trash now → keep their line from the ledger
    const doneBan = await sqlRead(`select evidence->>'phone' as phone, evidence->>'ban' as ban from public.data_repair_rows where run_id = ${qUuid(args.run)} and rule = 'teleshop-ban-trash'`);
    const doneBanSet = new Set(doneBan.map((r) => r.phone));
    combined.push(...doneBan.map(markerLine), ...markers.filter((m) => !doneBanSet.has(m.phone)).map(markerLine));
    const h2 = candidateHash(combined);
    if (h2 !== run.candidate_hash) die(`the plan changed since the dry run (hash ${h2.slice(0, 12)}… ≠ ${String(run.candidate_hash).slice(0, 12)}…) — run the dry run again (after 21:15 Skopje) and apply THAT run id.`);
    ok(`hash matches the dry run${doneSet.size ? ` — resuming, ${nf(doneSet.size)} already created` : ''}`);
    const actor = await resolveActor(args.actor || 'mile@elyon.com');
    // 1. MARKERS FIRST (review 28.09 #2): a do-not-contact phone is in sticky Trash before any of its
    //    orders exists, so a stopped apply (a crash, the 02:00 recompute) can never put it in a list.
    //    Their created_at (now) stays newer than every imported order (documents ≤ today).
    let banMarkers = 0;
    const todoMarkers = markers.filter((m) => !doneBanSet.has(m.phone));
    if (todoMarkers.length) {
      console.log(bold(`ban markers first (trash 'other' + note) for ${todoMarkers.length} phones …`));
      const r = await runChunks('ban-trash', todoMarkers, 500, (rows) => buildMarkerChunkSql({ runId: args.run, rows }));
      if (r.failed) die(`ban markers stopped: ${r.failed.error} — re-run to resume.`);
      banMarkers = r.applied;
    }
    const todo = plans.filter((p) => p.outcome === 'created' && !doneSet.has(p.doc_number));
    console.log(bold(`\napplying ${nf(todo.length)} new orders in ≤ ${chunkSize}-document transactions …`));
    const a = await runChunks('orders', todo, chunkSize, (chunk) => buildCreateChunkSql({ runId: args.run, chunk }));
    if (a.failed) die(`stopped at chunk ${a.failed.chunk}: ${a.failed.error}\n  committed chunks are in the ledger; re-run the same command to resume.`);
    // 3. existing collabBox orders ↔ their own free parcel (idempotent, no force; not hashed)
    let linked = 0;
    if (cls.links.length) {
      console.log(bold(`linking ${cls.links.length} existing collabBox orders to their own parcel …`));
      const r = await runChunks('links', cls.links, 200, (rows) => buildLinkChunkSql({ runId: args.run, rows }));
      if (r.failed) die(`links stopped: ${r.failed.error} — re-run to resume.`);
      linked = r.applied;
    }
    const rest = plans.filter((p) => p.outcome !== 'created');
    console.log(bold(`ledger rows for ${nf(rest.length)} not-created documents …`));
    const b = await runChunks('ledger', rest, 2000, (chunk) => buildLedgerChunkSql({ runId: args.run, chunk }));
    if (b.failed) die(`ledger stopped: ${b.failed.error} — re-run to resume.`);
    const customersA = buildCustomers(plans, cls.kVerdict, cls.profileByPhone, cls.isCrmPhone, resumeCreated);
    console.log(bold(`customers + profiles (${nf(customersA.length)} komitenti) …`));
    const c = await runChunks('customers', customersA, 1000, (chunk) => buildCustomersChunkSql({ runId: args.run, chunk }));
    if (c.failed) die(`customers stopped: ${c.failed.error} — re-run to resume.`);
    let relabelled = 0;
    if (relabel.length) {
      console.log(bold(`relabelling ${relabel.length} mislabelled 'teleshop' orders (--relabel-source) …`));
      const r = await runChunks('relabel', relabel, 500, (rows) => buildRelabelSql({ runId: args.run, rows }));
      if (r.failed) die(`relabel stopped: ${r.failed.error}`);
      relabelled = r.applied;
    }
    const payload = { relabelled, banMarkers, created: a.applied, links: a.links, linked_existing: linked, moved_since_dry_run: a.skipped.length, ledger: b.applied, customers: c.applied, profiles: c.extra, options };
    await sql(`update public.data_repair_runs set applied_at = now(), applied_by = ${qUuid(actor.id)},
        summary = coalesce(summary, '{}'::jsonb) || jsonb_build_object('apply', ${qJson(payload)}) where id = ${qUuid(args.run)} and applied_at is null;
      insert into public.audit_log (actor_id, actor_email, action, target_type, target_id, target_name, payload)
      values (${qUuid(actor.id)}, ${q(actor.email)}, 'data_repair.apply', 'data_repair_run', ${q(args.run)}, ${q(KEY)}, ${qJson(payload)});`);
    ok(`applied: ${nf(a.applied)} orders created, ${nf(a.links)} parcels linked, ${a.skipped.length} moved since the dry run (ledger: moved_since_dry_run)`);
    console.log(bold('\nNEXT (same quiet window, nothing else writing):'));
    console.log('  1. node scripts/import-teleshop-collabbox.mjs --drain          # settles the deferred segment queue');
    console.log('  2. node scripts/engine-fixture-mk.mjs                           # engine contract');
    console.log('  3. node scripts/verify-attribution.mjs --from 2026-09-01 --to 2026-09-27   # checker');
    return;
  }

  // ── DRY RUN ──────────────────────────────────────────────────────────────
  const blast = args['no-segments'] ? null : segmentBlastRadius({ plans, db, nowMs, markers });
  let cohort = null;
  if (!args['no-cohort']) {
    console.log(bold('\nsimulating the Insights cohort (read-only) …'));
    cohort = await cohortSimulation({ plans, parcels: cls.parcels, nowMs });
  }
  const S = summarize({ plans, customers, cls, blast, cohort, window, db, mexFrom });
  S.scopes = args['no-segments'] ? [] : scopeVariants({ plans, db, nowMs, scopes: [
    { key: 'A', label: 'само MEX период (од ' + mexFrom + ')', from: mexFrom },
    { key: 'B', label: 'цела 2026 (од 01.01.2026)', from: '2026-01-01' },
    { key: 'C', label: 'цела историја (од ' + window.from + ')', from: window.from },
  ] });
  printReport(S, blast, cohort);
  if (S.scopes.length) {
    console.log(bold('\n── scope options ──'));
    console.table(S.scopes.map((x) => ({ scope: `${x.key} ${x.label}`, orders: x.orders, 'ден': nf(x.mkd), 'of it legacy': nf(x.basis.paid_legacy_import?.mkd || 0),
      'new phones': x.new_phones, 'existing phones': x.existing_phones, 'members after': x.members_projected, 'out of Trash': x.released_from_trash })));
  }
  const ml = cls.mislabelled;
  const mlKinds = ml.reduce((a, r) => inc(a, `${r.doc_type || 'not in any crawl'} → ${r.target || 'unknown (left alone)'}`), {});
  console.log(bold(`\n── existing collabBox orders labelled 'teleshop' that are NOT teleshop documents: ${ml.length}`));
  console.log(`  ${Object.entries(mlKinds).map(([k, v]) => `${k} ×${v}`).join(' · ')}${args['relabel-source'] ? '  (WILL be relabelled)' : '  (report only — --relabel-source relabels them)'}`);
  S.mislabelled = { n: ml.length, kinds: mlKinds };
  // bans
  const banKom = [...cls.kVerdict.values()].filter((v) => v.ban);
  const banDocs = plans.filter((p) => p.k?.ban);
  const banBy = banDocs.reduce((a, p) => { const k = `${p.k.ban}:${p.outcome}`; bump(a, k, 1, p.amount > 0 ? p.amount : 0); return a; }, {});
  const existBy = cls.existingBanned.reduce((a, b) => { bump(a, b.ban, 1, 0); a[b.ban].orders = (a[b.ban].orders || 0) + b.crm_orders; return a; }, {});
  console.log(bold(`\n── banned customers (deceased / do-not-contact): ${banKom.length} komitenti${args['banned-as-trash'] ? ' — IMPORTED + trash marker (--banned-as-trash)' : ' — skipped (default)'}`));
  console.log(`  their documents: ${Object.entries(banBy).map(([k, v]) => `${k} ${nf(v.n)} / ${nf(v.mkd)} ден`).join(' · ')}`);
  console.log(`  already CRM customers (their exact CRM phone strings): ${Object.entries(existBy).map(([k, v]) => `${k} ${v.n} phones / ${v.orders} orders`).join(' · ')}${args['trash-banned-existing'] ? ' — WILL get a trash marker' : ' (--trash-banned-existing marks them)'}`);
  console.log(`  trash markers planned: ${markers.length} (imported ${markers.filter((m) => m.source === 'imported').length}, existing ${markers.filter((m) => m.source === 'existing').length}); already permanently trashed, no marker needed: ${[...cls.bannedPhones.values(), ...cls.existingBanned].filter((m) => m.already_trashed).length}`);
  S.bans = { komitenti: banKom.length, docs: banBy, existing: existBy, markers: markers.length };
  // stornos + reused numbers
  const sp = cls.stornoPairs;
  console.log(bold(`\n── stornos: ${sp.length}`) + ` — paired with the document they reverse: ${sp.filter((x) => x.original).length}${args['keep-storno-originals'] ? ' (originals KEPT)' : ' (originals excluded as reversed_by_storno)'}; ambiguous ${sp.filter((x) => x.candidates > 1).length}; no match ${sp.filter((x) => !x.candidates).length}`);
  console.log(bold(`── reused document numbers: ${cls.reused.length}`) + ' — never imported, never linked:');
  for (const r of cls.reused) console.log(`  ${r.doc_number}: ${r.documents}${r.crm_order ? ` · CRM ${r.crm_order}` : ''}${r.parcel ? ` · parcel ${r.parcel}` : ''}`);
  S.stornos = { n: sp.length, paired: sp.filter((x) => x.original).length }; S.reused = cls.reused.length;
  const lk = cls.links.reduce((a, l) => { bump(a, l.detail || '?', 1, Number(l.cod_mkd) || 0); return a; }, {});
  console.log(bold(`── existing collabBox orders linked to their OWN unlinked parcel: ${cls.links.length}`) + ` (${Object.entries(lk).map(([k, v]) => `${k} ${v.n} / ${nf(v.mkd)} ден COD`).join(' · ')}) — not linked: ${Object.entries(cls.linkSkipped.reduce((a, l) => inc(a, l.why), {})).map(([k, v]) => `${k} ${v}`).join(' · ') || '—'}`);
  S.links = { n: cls.links.length, byDetail: lk, skipped: cls.linkSkipped.length };
  console.log(`  customer rules: ${Object.entries(S.customerRules).map(([k, v]) => `${k} ${nf(v)}`).join(' · ')}`);

  const stamp = fileStamp();
  const docCsv = writeCsvFile(`teleshop-documents-${stamp}.csv`, plans.map((p) => ({
    doc_number: p.doc_number, type: p.type_id, series: p.series, doc_at_skopje: p.doc.doc_at ? fmtSkopje(p.doc.doc_at) : p.doc.datum_raw,
    komitent_id: p.doc.komitent_id, name: p.name ?? p.k?.name ?? T.cleanName(p.doc.komitent_name), author: p.author ?? p.doc.author, author_crawl: p.doc.author, amount_mkd: p.amount, price_eur: p.price,
    outcome: p.outcome, reason: p.reason, reason_mk: reasonMk(p.reason), status: p.status, paid_basis: p.basis, phone: p.phone, phone_source: p.phone_src,
    customer_match: p.match, tracking: p.tracking, parcel_status: p.parcel?.status_id, parcel_cod: p.parcel?.cod_mkd, related_order: p.relatedDisplay || p.related,
    flags: p.flags, source: p.doc.source,
  })));
  const custCsv = writeCsvFile(`teleshop-customers-${stamp}.csv`, customers.map(({ lastAt, primary, ...c }) => ({ ...c, primary: !!primary })));
  writeCsvFile(`teleshop-mislabelled-${stamp}.csv`, cls.mislabelled);
  writeCsvFile(`teleshop-stornos-${stamp}.csv`, cls.stornoPairs);
  writeCsvFile(`teleshop-links-${stamp}.csv`, [...cls.links.map((l) => ({ ...l, action: 'link' })), ...cls.linkSkipped.map((l) => ({ ...l, action: 'not_linked' }))]);
  writeCsvFile(`teleshop-reused-numbers-${stamp}.csv`, cls.reused);
  writeCsvFile(`teleshop-banned-${stamp}.csv`, [...[...cls.bannedPhones.values()], ...cls.existingBanned].map((m) => ({ ...m, marker: markers.includes(m) })));
  const segCsv = blast ? writeCsvFile(`teleshop-segments-${stamp}.csv`, blast.phones) : null;
  ok(`CSVs → ${docCsv}\n     ${custCsv}${segCsv ? `\n     ${segCsv}` : ''}`);

  let runId = null;
  if (args.record) {
    if (!schemaOk) die('--record needs the migration applied (the apply writes the ledger).');
    const [r] = await sql(`insert into public.data_repair_runs (key, dry_run, candidate_hash, summary)
        values (${q(KEY)}, true, ${q(hash)}, ${qJson({ options, lines: lines.length, outcome: S.byOutcome, created: S.created.byStatus, phones: S.phones })}) returning id`);
    runId = r.id;
    ok(`dry run recorded — run id ${bold(runId)} (hash ${hash.slice(0, 12)}…)`);
    console.log(`  apply: node scripts/import-teleshop-collabbox.mjs --apply --run ${runId}${args.from ? ` --from ${args.from}` : ''}${args.to ? ` --to ${args.to}` : ''}${args.fetch ? ` --fetch ${args.fetch}` : ''}`);
  } else console.log(`  hash ${hash.slice(0, 16)}… (not recorded — add --record in the quiet window to get a run id)`);

  writeFileSync(join(OUT_DIR, `teleshop-summary-${stamp}.json`), JSON.stringify({ S, lists: blast?.lists, transitions: blast?.topTransitions, cohort, hash, runId }, null, 1));
  if (!args['no-xlsx']) {
    const x = writeOwnerXlsx(args.xlsx || join(OUT_DIR, `${today}-teleshop-uvoz-proba.xlsx`), { S, blast, cohort, plans, customers, runId, hash });
    ok(`owner sheet → ${x}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(red(e.stack || e.message || e)); process.exit(1); });
}
