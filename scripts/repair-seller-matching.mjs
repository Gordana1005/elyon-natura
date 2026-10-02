/**
 * Seller matching — WHO SOLD the real sales the stamping cron leaves `unresolved` (owner, Mile,
 * 01.10.2026: "try matching ALL first" — the phone rule ignoring the amount on the old ones too —
 * "then the owner decides"). No shebang (repair-kit convention). Run with `node`.
 *
 *   node scripts/repair-seller-matching.mjs                         # DRY RUN, every source → CSV → data_repair_runs row → run id
 *   node scripts/repair-seller-matching.mjs --sources own-doc,export-phone      # only the sources the owner approved
 *   node scripts/repair-seller-matching.mjs --apply --run <id> [--sources …]    # stamp (quiet window; the SAME --sources)
 *        [--actor mile@elyon.com] [--chunk 200] [--outside-quiet-window]
 *   node scripts/repair-seller-matching.mjs --rollback --run <id> [--apply]     # undo one applied run
 *   options (recorded; the apply must repeat them):
 *     --sources <csv>     default: all of SOURCES below
 *     --collab-dir <dir>  the collabBox harvest (default C:\Users\Mile\collab_out — the 01.10.2026 10:25 refresh:
 *                         09-site-nalozi-zaedno/orders_ALL_combined.csv + 08-komitenti-klienti/komitenti_full.csv)
 *     --data-dir <dir>    where altercpa-mk-raw.jsonl (AlterCPA's own order list, 05.08.2026) and
 *                         collabbox-corrections.csv live (gitignored PII; default scripts/data, else the
 *                         main checkout ../elyon-natura/scripts/data next to this worktree)
 *     --no-precision      skip the precision pass (the apply always skips it)
 *     --preview           a dry run that records nothing (no data_repair_runs row)
 *     --orders <file>     stamp ONLY these sales (ORD-… or uuids; the owner's corroborated list) — the rest is
 *                         classified and reported, never stamped
 *
 * ── WHICH ORDERS ─────────────────────────────────────────────────────────────
 * EXACTLY the population of the stamping cron and its parity gate: order_decider_plan(10 years)
 * action = 'unresolved' (verify-stamp-parity.mjs). Stamped only while it is a cohort sale now
 * (cohort_in_total(cohort_order_bucket(…)), MEX first) — so the AlterCPA leads whose MEX "sale" a
 * repair has since undone (cancelled / trashed, no parcel: migration 20260944001200 takes them out
 * of the plan) are listed as `not_a_sale_now`, never stamped. Never a test phone.
 *
 * ── WHO SOLD IT — the credit rule (owner): the FIRST confirmer / decider wins (AlterCPA operator,
 *    CRM agent), else the collabBox author. MEX + collabBox are the truth; nothing goes to AlterCPA.
 * Sources, in precedence order (each one a flag, so the owner can approve them one by one):
 *   operator        the AlterCPA operator of a 2026-08 history import, from AlterCPA's own order list
 *                   (altercpa-mk-raw.jsonl — `app` who approved, else `user` who handled: the cron's
 *                   history_import order), when that login IS a person (sales_person_identities kind
 *                   altercpa_user of the MK account).                                sold_via altercpa
 *   login-names     the same operator through a PROPOSED person for an unnamed login IN THAT MONTH: the
 *                   collabBox author of ≥ 85 % of the ≥ 20 approvals of that login in that Skopje month
 *                   that the phone rule ties to one LEADS document (a thinner month borrows the login's
 *                   whole-life author only when every well-evidenced month agrees). Logins change hands
 *                   (3807 = one person Jan–Mar 2026, several in April; 3054 = one person Aug–Oct 2025),
 *                   so a shared month never qualifies. The owner approves the table the dry run prints.
 *                                                                                  sold_via altercpa
 *   own-doc         the collabBox document whose DocNumber is the order's own parcel (live ledger, else
 *                   the 01.10 export): its author raised THIS shipment. Not for a history import from
 *                   before 02.04.2026 — its parcel was linked later by phone (19–30 % precision).  collabbox
 *   mex-phone       parcel-less orders only: an unlinked BIO NATURAL / 9110 / 9103 MEX parcel on the
 *                   customer's last-8 phone created −1 d … +10 d of the order → its document's author.
 *   db-phone        …a LEADS / LEADS-OUT document in the live ledger on that phone (document phone,
 *                   collabbox_customers, or the komitent register), dated −1 d … +10 d.
 *   export-phone    …the same in the local 01.10 export (the only source before 01.03.2026).
 *                   The three phone sources IGNORE THE AMOUNT (owner) and take a document only when it
 *                   names ONE author, no order / parcel / web order holds it, and no other parcel-less
 *                   lead sale on the phone could own it (its own −1 … +10 d window) — the amount-free
 *                   form of the 28.09 "fits two orders" rule. Two phone sources that name different
 *                   authors hold the order. "The old ones" only: a sale from 02.04.2026 on (the MEX
 *                   register) that still holds no parcel is not the sale a document on its phone shipped
 *                   (precision 37–80 % there against 92–93 % before) — those are left to the owner.  collabbox
 *   corrections     the 05.08.2026 matcher (scripts/data/collabbox-corrections.csv): this AlterCPA lead
 *                   id ↔ one collabBox document by customer name (tier A exact / B fuzzy), one author.
 *                   Old ones only, like the phone sources.
 *   canceller       an AlterCPA lead whose operator CANCELLED it but MEX moved its parcel, and the
 *                   parcel's document is gone from collabBox: that operator.            sold_via altercpa
 *   canceller-trashed  the same for a TRASHED lead (weaker — see the precision table).
 * The window −1 d … +10 d is the owner's phone + date link law (01.10, link_lead_parcels_plan: an order
 * created −10 d … +1 d of its parcel) seen from the order; wider windows find no more and lose precision.
 *
 * Nothing names a person in the import columns (confirmed_by_name 'Import' / NULL, assigned_agent_name
 * NULL on every one of these), order_notes or audit_log (only CANCEL pushes, which never credit).
 *
 * sold_at = the order's cohort sale moment today (coalesce(AlterCPA approval, confirmed_at, created_at) —
 * the cron's history_import / collabbox_author time): no sale moves to another day or month.
 * sold_by_ext: the AlterCPA user id (altercpa) or the collabBox author as the identities spell it (the
 * 28.09 resolver), so naming a person later in Settings → Teams back-stamps an unmapped author.
 *
 * ── APPLY / ROLLBACK (repair-kit protocol, same SQL as backfill-sellers-collabbox.mjs) ─────────────
 * Re-classify, refuse unless the hash equals the dry run's; ≤ 200-order transactions with
 * elyon.bulk_repair + elyon.keep_updated_at, FOR NO KEY UPDATE, only orders still unstamped with the
 * planned status + tracking id; data_repair_rows before → UPDATE sold_* (NULL → value; the write-once
 * trigger stays on) → verify → after. --rollback clears one run's stamps where they still equal the
 * after-image (elyon.allow_sold_change).
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards). The collabBox and AlterCPA files are read, never written.
 */
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MAX_CHUNK, MKD_PER_EUR, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qTextArray, qJson, parseArgs, fmtSkopje, fmtMkd, fileStamp, writeCsv, printTable,
  planLine, candidateHash, recordDryRun, verifyRunForApply, applyChunked, finalizeRun, auditPartial, resolveActor, isUuid,
} from './lib/repair-kit.mjs';
import {
  parseCsv, skopjeLocalToUtc, makeResolver, buildStampChunkSql, buildRollbackChunkSql,
} from './backfill-sellers-collabbox.mjs';

export const KEY = 'seller-matching';
export const SOURCES = Object.freeze(['operator', 'login-names', 'own-doc', 'mex-phone', 'db-phone', 'export-phone', 'corrections', 'canceller', 'canceller-trashed']);
const PHONE_SOURCES = ['mex-phone', 'db-phone', 'export-phone'];
/** Outcomes of the own-parcel test that say the parcel is not this sale's — held whatever sources are enabled. */
export const PARCEL_HOLDS = Object.freeze(['doc_conflict', 'channel_mismatch', 'doc_predates_order', 'parcel_shared', 'non_collabbox_parcel']);
const REAL = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];
const DEFAULT_COLLAB_DIR = 'C:/Users/Mile/collab_out';
/** Нарачка LEADS (9110) · LEADS-OUT Нарачка (9103) — the BIO NATURAL lead documents. */
export const LEAD_TYPES = new Set(['10111', '10114']);
const H = 3_600_000;
const D = 24 * H;
export const WINDOW = Object.freeze({ beforeMs: 1 * D, afterMs: 10 * D });
const PREDATES_MS = 48 * H;
export const LOGIN_MIN_SHARE = 0.85;
export const LOGIN_MIN_DOCS = 20;
const DOC_RE = /^\d{3}-\d{4}-\d+\/\d{4}$/;
const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const ms = (v) => new Date(v).getTime();
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/** Period of the cohort sale day (Skopje): before 01.03.2026 · March (no MEX yet) · from 02.04.2026 (MEX). */
export function periodOf(saleAt) {
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' }).format(new Date(saleAt));
  return day < '2026-03-01' ? 'before_march' : day < '2026-04-02' ? 'march' : 'from_april';
}

// ─── evidence files (local, read-only) ──────────────────────────────────────
function dataFile(dir, name) {
  const cands = dir ? [join(dir, name)] : [join(ROOT, 'scripts', 'data', name), join(ROOT, '..', 'elyon-natura', 'scripts', 'data', name)];
  const f = cands.find((p) => existsSync(p));
  if (!f) die(`${name} not found (looked in ${cands.join(' · ')}) — pass --data-dir.`);
  return f;
}

export function loadExport(dir) {
  const docsPath = join(dir, '09-site-nalozi-zaedno', 'orders_ALL_combined.csv');
  const komPath = join(dir, '08-komitenti-klienti', 'komitenti_full.csv');
  const raw = readFileSync(docsPath);
  const docs = parseCsv(raw.toString('utf8')).map((d) => ({
    doc: d.DocNumber, tip: d.TipID, komitent: d.KomitentID, author: ws(d.Avtor),
    at: skopjeLocalToUtc(d.Datum), datum: d.Datum,
  })).filter((d) => d.doc && d.at);
  const komRaw = readFileSync(komPath);
  const phonesOf = new Map();
  for (const k of parseCsv(komRaw.toString('utf8'))) {
    const ps = [...new Set([k.Telefon, k.Mobilen].map((x) => String(x ?? '').replace(/\D/g, '').slice(-8)).filter((x) => x.length === 8))];
    if (ps.length) phonesOf.set(k.Sifra, ps);
  }
  const byNum = new Map();
  const leadByP8 = new Map();
  for (const d of docs) {
    (byNum.get(d.doc) ?? byNum.set(d.doc, []).get(d.doc)).push(d);
    if (!LEAD_TYPES.has(d.tip)) continue;
    for (const p of phonesOf.get(d.komitent) || []) (leadByP8.get(p) ?? leadByP8.set(p, []).get(p)).push(d);
  }
  return { docsPath, komPath, docsSha: sha256(raw), komSha: sha256(komRaw), docs: docs.length, phonesOf, byNum, leadByP8,
    mtime: statSync(docsPath).mtime };
}

const SKOPJE_MONTH = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit' });
const monthOf = (msOrDate) => SKOPJE_MONTH.format(new Date(msOrDate)).slice(0, 7);

/**
 * AlterCPA's own order list: the operator of every population lead, and the login → author tally —
 * per login AND per (login, Skopje month), because a login changes hands (3807 is one person
 * January–March 2026 and several in April; 3054 one person August–October 2025).
 */
export async function loadAltercpaRaw(path, wantIds, exp) {
  const raw = new Map();
  const tally = new Map();   // 'login' and 'login|YYYY-MM' → Map(author → n)
  const hash = createHash('sha256');
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    hash.update(line).update('\n');
    if (!line) continue;
    const m = line.match(/^\{"id":(\d+),/);
    const wanted = m && wantIds.has(m[1]);
    if (!wanted && !line.includes('"country":"mk"')) continue;
    const j = JSON.parse(line);
    const t0 = j.time * 1000;
    if (wanted) raw.set(String(j.id), { app: j.app || 0, user: j.user || 0, status: j.status, reason: j.reason, month: monthOf(t0) });
    if (j.country !== 'mk' || !j.app) continue;   // the tally counts approvals only
    const p8 = String(j.phone || '').replace(/\D/g, '').slice(-8);
    if (p8.length !== 8) continue;
    const win = (exp.leadByP8.get(p8) || []).filter((d) => d.at.getTime() >= t0 - WINDOW.beforeMs && d.at.getTime() <= t0 + WINDOW.afterMs);
    const as = new Set(win.map((d) => d.author));
    if (as.size !== 1) continue;
    const a = [...as][0];
    for (const k of [String(j.app), `${j.app}|${monthOf(t0)}`]) {
      const t = tally.get(k) ?? tally.set(k, new Map()).get(k);
      t.set(a, (t.get(a) || 0) + 1);
    }
  }
  return { raw, tally, sha: hash.digest('hex') };
}

export function loadCorrections(path) {
  const buf = readFileSync(path);
  const lines = buf.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => !/^sep=/.test(l));
  const head = lines[0].split(';');
  const by = new Map();
  for (const l of lines.slice(1)) {
    const c = l.split(';');
    if (c.length < head.length - 1) continue;
    const r = Object.fromEntries(head.map((h, i) => [h, c[i]]));
    if (!r.altercpa_id || (r.tier !== 'A' && r.tier !== 'B')) continue;
    (by.get(r.altercpa_id) ?? by.set(r.altercpa_id, []).get(r.altercpa_id)).push({ tier: r.tier, doc: r.collabbox_doc, author: ws(r.collabbox_author), outcome: r.outcome });
  }
  return { by, sha: sha256(buf) };
}

// ─── loaders (read-only SQL) ────────────────────────────────────────────────
export function candidatesSql() {
  return `
with ex as (select public.report_excluded_phone8s() as p8s),
p as materialized (
  select order_id, bucket from public.order_decider_plan(interval '10 years') where action = 'unresolved'
)
select o.id, o.display_id, o.status::text as status, o.sale_source, o.sale_source_detail as det,
       o.created_at, o.price, o.mex_tracking_id as tr, o.external_order_id as ext_id,
       public.insights_phone8(o.customer_phone) as p8, o.confirmed_by_name, o.assigned_agent_name,
       p.bucket as plan_bucket, b.bucket as cohort_bucket, public.cohort_in_total(b.bucket) as in_total,
       coalesce(la.decided_at, o.confirmed_at, o.created_at)::text as sale_at,
       public.insights_excluded8(public.insights_phone8(o.customer_phone), ex.p8s) as test_phone,
       l.decision, l.decided_by_altercpa_user as lead_user, l.account_id as lead_account,
       (select coalesce(json_agg(mp.tracking_id order by mp.tracking_id), '[]'::json)
          from public.mex_parcels mp where mp.order_id = o.id) as parcels
  from p
  join public.orders o on o.id = p.order_id
  cross join ex
  left join lateral (select max(l2.decided_at) as decided_at from public.altercpa_leads l2
                      where l2.order_id = o.id and l2.decision in ('approved', 'cancel_other')
                        and l2.decided_at is not null) la on true
  left join lateral (select l3.decision, l3.decided_by_altercpa_user, l3.account_id from public.altercpa_leads l3
                      where l3.order_id = o.id order by l3.last_seen_at desc, l3.id limit 1) l on true
  cross join lateral (select public.cohort_order_bucket(o.status::text, o.price, o.sold_at, o.paid_basis, o.source_type,
                        o.sale_source_detail, o.mex_tracking_id, o.mex_status_id, o.mex_cod_mkd, o.mex_delivered_at,
                        coalesce(o.mex_tracking_id in (select w.mex_tracking_id from public.web_orders w
                                                        where w.mex_tracking_id is not null and w.deleted_in_shop_at is null), false)) as bucket) b
 order by o.id`;
}

/** Parcel-less real sales that could own a LEADS document (an AlterCPA lead or an Affiliate re-sale). */
const competitorsSql = () => `
select o.id, public.insights_phone8(o.customer_phone) as p8, o.created_at
  from public.orders o
 where o.status::text in (${REAL.map((s) => `'${s}'`).join(', ')})
   and coalesce(o.price, 0) > 0 and not public.is_synthetic_product_name(o.product_name)
   and o.sale_source in ('altercpa', 'elyon_crm') and o.sale_source_detail is distinct from 'disposition'
   and o.external_source is distinct from 'collabbox'
   and o.mex_tracking_id is null
   and not exists (select 1 from public.mex_parcels mp where mp.order_id = o.id)`;

async function loadDb() {
  const [acc] = await sqlRead(`select array_agg(id::text) as ids from public.altercpa_accounts where 'MK' = any(callable_geos)`);
  if (!acc?.ids || acc.ids.length !== 1) die(`expected exactly one AlterCPA account calling MK, found ${acc?.ids?.length ?? 0}`);
  const ledger = await sqlRead(`select doc_number as doc, doc_type_id as tip, author, author_person_id::text as apid, doc_at,
      phone8, komitent_id as komitent, order_id::text as order_id, vanished_at
    from public.collabbox_documents where doc_type_id in ('10111', '10114') or doc_number ~ '^\\d{3}-(9110|9103)-'`);
  const customers = await sqlRead(`select komitent_id, phone8 from public.collabbox_customers where phone8 is not null`);
  const parcels = await sqlRead(`select tracking_id, phone8, created_at_mex, order_id::text as order_id
    from public.mex_parcels where account = 'bio_natural' or series in ('9110', '9103')`);
  const competitors = await sqlRead(competitorsSql());
  return { mkAccount: acc.ids[0], ledger, customers, parcels, competitors };
}

/** Who holds a document number: an order naming it (tracking or collabBox DocNumber), the register, the ledger, a web order. */
export async function loadHolders(nums) {
  const out = new Map();
  const list = [...new Set(nums)].filter(Boolean);
  for (let i = 0; i < list.length; i += 3000) {
    const arr = qTextArray(list.slice(i, i + 3000));
    const rows = await sqlRead(`select tr, string_agg(distinct who, ' ') as who from (
        select mex_tracking_id as tr, id::text as who from public.orders where mex_tracking_id = any(${arr})
        union all select external_order_id, id::text from public.orders where external_source = 'collabbox' and external_order_id = any(${arr})
        union all select tracking_id, order_id::text from public.mex_parcels where tracking_id = any(${arr}) and order_id is not null
        union all select doc_number, order_id::text from public.collabbox_documents where doc_number = any(${arr}) and order_id is not null
        union all select mex_tracking_id, 'web:' || shop_order_id::text from public.web_orders where mex_tracking_id = any(${arr}) and deleted_in_shop_at is null
      ) z group by tr`);
    for (const r of rows) out.set(r.tr, new Set(String(r.who).split(' ')));
  }
  return out;
}

async function loadPeople() {
  const idents = await sqlRead(`select i.kind, i.value, i.account_id::text as account_id, i.person_id::text as person_id, sp.display_name, sp.is_manager, sp.user_id
    from public.sales_person_identities i join public.sales_people sp on sp.id = i.person_id`);
  const people = await sqlRead(`select id::text as id, display_name, is_manager, user_id from public.sales_people`);
  const cbxExt = await sqlRead(`select distinct sold_by_ext as ext from public.orders where sold_via = 'collabbox' and sold_by_ext is not null`);
  return { idents, people, cbxExt: cbxExt.map((r) => r.ext) };
}

// ─── the evidence context (pure once loaded) ────────────────────────────────
export function buildContext({ exp, db, holders, resolver, idents, raw, corrections, logins, opts }) {
  const ledgerByNum = new Map();
  const ledgerByP8 = new Map();
  const custPhones = new Map();
  for (const c of db.customers) (custPhones.get(c.komitent_id) ?? custPhones.set(c.komitent_id, new Set()).get(c.komitent_id)).add(c.phone8);
  for (const d of db.ledger) {
    if (d.vanished_at) continue;
    const doc = { doc: d.doc, tip: d.tip, author: ws(d.author), apid: d.apid, at: new Date(d.doc_at), orderId: d.order_id };
    ledgerByNum.set(d.doc, doc);
    if (!LEAD_TYPES.has(d.tip)) continue;
    const ps = new Set([d.phone8, ...(custPhones.get(d.komitent) || []), ...(exp.phonesOf.get(d.komitent) || [])].filter(Boolean));
    for (const p of ps) (ledgerByP8.get(p) ?? ledgerByP8.set(p, []).get(p)).push(doc);
  }
  const parcelsByP8 = new Map();
  for (const m of db.parcels) if (m.phone8) (parcelsByP8.get(m.phone8) ?? parcelsByP8.set(m.phone8, []).get(m.phone8)).push(m);
  const compByP8 = new Map();
  for (const s of db.competitors) if (s.p8) (compByP8.get(s.p8) ?? compByP8.set(s.p8, []).get(s.p8)).push({ id: s.id, t: ms(s.created_at) });
  const altUser = new Map();
  for (const i of idents) if (i.kind === 'altercpa_user') altUser.set(`${i.account_id}:${i.value}`, i);
  /** the live ledger first (current author), else the export */
  const docOf = (num) => {
    const l = ledgerByNum.get(num);
    if (l) return { ...l, from: 'ledger' };
    const e = exp.byNum.get(num);
    if (!e?.length) return null;
    const authors = new Set(e.map((x) => x.author));
    return { doc: num, tip: e[0].tip, author: authors.size === 1 ? e[0].author : null, authors, at: e[0].at, from: 'export' };
  };
  return { exp, db, holders, resolver, raw, corrections, logins, opts, ledgerByNum, ledgerByP8, parcelsByP8, compByP8, altUser, docOf };
}

const inWindow = (o, d) => d.at.getTime() >= ms(o.created_at) - WINDOW.beforeMs && d.at.getTime() <= ms(o.created_at) + WINDOW.afterMs;

/** Phone-rule candidate documents of one source for an order (before the single-author test). */
export function phoneDocs(src, o, ctx) {
  if (src === 'export-phone') return (ctx.exp.leadByP8.get(o.p8) || []).map((d) => ({ doc: d.doc, author: d.author, at: d.at }));
  if (src === 'db-phone') return (ctx.ledgerByP8.get(o.p8) || []).map((d) => ({ doc: d.doc, author: d.author, at: d.at, apid: d.apid }));
  if (src === 'mex-phone') {
    return (ctx.parcelsByP8.get(o.p8) || []).filter((m) => !m.order_id || m.order_id === o.id).map((m) => {
      const d = ctx.docOf(m.tracking_id);
      return d && d.author && LEAD_TYPES.has(d.tip) ? { doc: m.tracking_id, author: d.author, at: new Date(m.created_at_mex), apid: d.apid } : null;
    }).filter(Boolean);
  }
  throw new Error(`not a phone source: ${src}`);
}

/**
 * The amount-free phone rule: documents in −1 d … +10 d, none held by another order, ONE author, and no
 * other parcel-less lead sale on the phone whose own window reaches a candidate document.
 */
export function phonePick(src, o, ctx) {
  if (!o.p8 || String(o.p8).length !== 8) return { r: 'no_phone' };
  const all = phoneDocs(src, o, ctx);
  if (!all.length) return { r: 'no_doc_for_phone' };
  const win = all.filter((d) => inWindow(o, d));
  if (!win.length) return { r: 'no_doc_in_window' };
  const free = win.filter((d) => ![...(ctx.holders.get(d.doc) || [])].some((w) => w !== o.id));
  if (!free.length) return { r: 'doc_held_by_another_order' };
  if (new Set(free.map((d) => d.author)).size > 1) return { r: 'several_authors', ambiguous: true };
  const rivals = (ctx.compByP8.get(o.p8) || []).filter((s) => s.id !== o.id
    && free.some((d) => d.at.getTime() >= s.t - WINDOW.beforeMs && d.at.getTime() <= s.t + WINDOW.afterMs));
  if (rivals.length) return { r: 'doc_fits_another_sale', ambiguous: true };
  const d = [...free].sort((a, b) => a.at - b.at)[0];
  return { ok: true, doc: d.doc, author: d.author, at: d.at, apid: d.apid ?? null, docs: free.length };
}

/**
 * The login → person tallies: one row per login and per (login, month) — `key` 'login' or 'login|YYYY-MM'.
 * A row is `strong` when ≥ LOGIN_MIN_DOCS tied approvals carry one author at ≥ LOGIN_MIN_SHARE who is a person.
 */
export function loginTallies(tally, resolver, altUser, mkAccount) {
  const out = new Map();
  for (const [key, m] of tally) {
    const [login, month = null] = key.split('|');
    const ranked = [...m].sort((a, b) => b[1] - a[1]);
    const n = ranked.reduce((s, x) => s + x[1], 0);
    const [author, top] = ranked[0];
    const who = resolver.author(author);
    const share = top / n;
    const named = altUser.get(`${mkAccount}:${login}`) || null;
    out.set(key, {
      key, login, month, docs: n, author, share, person_id: who.person_id,
      second: ranked[1] ? `${ranked[1][0]} ${Math.round((100 * ranked[1][1]) / n)}%` : '',
      identity: named?.display_name ?? null,
      strong: !!who.person_id && share >= LOGIN_MIN_SHARE && n >= LOGIN_MIN_DOCS,
    });
  }
  return out;
}

/**
 * The PROPOSED person behind an unnamed login in a month, or null:
 *   a month with ≥ LOGIN_MIN_DOCS tied approvals decides by itself (strong → that author, else nobody);
 *   a thinner month takes the login's whole-life author when that is strong AND every well-evidenced
 *   month of the login agrees on the same person (so a login that changed hands never qualifies).
 * A login the owner already named (an altercpa_user identity) is the `operator` source, never this.
 */
export function proposalFor(logins, login, month, { ignoreIdentity = false } = {}) {
  const all = logins.get(String(login));
  if (!all || (all.identity && !ignoreIdentity)) return null;
  const mo = month ? logins.get(`${login}|${month}`) : null;
  if (mo && mo.docs >= LOGIN_MIN_DOCS) return mo.strong ? { ...mo, basis: 'month' } : null;
  if (!all.strong) return null;
  for (const x of logins.values()) {
    if (x.login === String(login) && x.month && x.docs >= LOGIN_MIN_DOCS && (!x.strong || x.person_id !== all.person_id)) return null;
  }
  return { ...all, basis: 'login' };
}

/**
 * Every source's verdict for one order, then the first enabled source in precedence order.
 * → { outcome: stamp | hold | unknown | skip, source, via, person_id, ext, sold_at, reason, ev }
 */
export function classify(o, ctx) {
  const on = ctx.opts.sources;
  const trackings = [...new Set([o.tr, ...(o.parcels || [])].filter(Boolean))];
  const base = {
    order_id: o.id, display_id: o.display_id, status: o.status, det: o.det, period: periodOf(o.sale_at),
    group: o.det === 'history' ? `history_${periodOf(o.sale_at)}` : (trackings.length ? 'altercpa_with_parcel' : 'altercpa_no_parcel'),
    bucket: o.cohort_bucket, sale_at: o.sale_at, tracking: trackings.join(' '),
    value_mkd: Math.round(Number(o.price || 0) * MKD_PER_EUR),
    altercpa: o.decision ? `${o.decision} by #${o.lead_user ?? '?'}` : '',
  };
  const ev = {};

  // operator (history imports: AlterCPA's own order list)
  const r = o.det === 'history' ? ctx.raw.get(String(o.ext_id)) : null;
  if (r) {
    const id = String(r.app || r.user || '');
    const ident = id ? ctx.altUser.get(`${ctx.db.mkAccount}:${id}`) : null;
    const prop = id && !ident ? proposalFor(ctx.logins, id, r.month) : null;
    ev.operator = { login: id, month: r.month, field: r.app ? 'app' : 'user', altercpa_status: r.status, person_id: ident?.person_id ?? null,
      proposal: prop ? { person_id: prop.person_id, author: prop.author, share: prop.share, docs: prop.docs, basis: prop.basis } : null,
      evidence: ctx.logins.has(id) };
  }

  // own parcel's document
  if (trackings.length) {
    const docs = trackings.map((t) => ctx.docOf(t)).filter(Boolean);
    if (docs.length) {
      const authors = new Set(docs.flatMap((d) => (d.author ? [d.author] : [...(d.authors || [])])));
      const d = docs[0];
      const others = trackings.flatMap((t) => [...(ctx.holders.get(t) || [])]).filter((w) => w !== o.id);
      ev['own-doc'] = authors.size !== 1 ? { r: 'doc_conflict' }
        : !docs.every((x) => LEAD_TYPES.has(x.tip)) ? { r: 'channel_mismatch', doc: d.doc, tip: d.tip }
          : d.at.getTime() < ms(o.created_at) - PREDATES_MS ? { r: 'doc_predates_order', doc: d.doc }
            : others.length ? { r: 'parcel_shared', doc: d.doc }
              : { ok: true, doc: d.doc, author: [...authors][0], at: d.at, apid: d.apid ?? null, from: d.from };
    } else ev['own-doc'] = { r: trackings.some((t) => DOC_RE.test(t)) ? 'parcel_document_gone' : 'non_collabbox_parcel' };
  } else {
    for (const src of PHONE_SOURCES) ev[src] = phonePick(src, o, ctx);
  }

  // the 05.08 corrections matcher
  const corr = o.det === 'history' ? ctx.corrections.get(String(o.ext_id)) : null;
  if (corr?.length) {
    const as = new Set(corr.map((c) => c.author));
    ev.corrections = as.size === 1 ? { ok: true, author: [...as][0], doc: corr[0].doc, tier: corr.map((c) => c.tier).join('') } : { r: 'several_authors', ambiguous: true };
  }

  // the AlterCPA operator who cancelled / trashed the lead
  if ((o.decision === 'cancelled' || o.decision === 'trashed') && o.lead_user != null) {
    const ident = ctx.altUser.get(`${o.lead_account}:${o.lead_user}`);
    ev[o.decision === 'cancelled' ? 'canceller' : 'canceller-trashed'] = { ok: true, ext: String(o.lead_user), person_id: ident?.person_id ?? null };
  }

  const out = { ...base, ev };
  const stamp = (source, via, who, extra = {}) => ({ ...out, outcome: 'stamp', source, via, person_id: who.person_id ?? null, ext: who.ext, sold_at: o.sale_at, ...extra });
  const author = (e) => { const w = ctx.resolver.author(e.author); return { person_id: w.person_id ?? e.apid ?? null, ext: w.ext }; };

  if (!o.in_total) return { ...out, outcome: 'skip', reason: 'not_a_sale_now' };
  if (o.test_phone) return { ...out, outcome: 'skip', reason: 'test_phone' };

  // 1. the AlterCPA operator — the first decider wins
  if (ev.operator?.person_id && on.has('operator')) return stamp('operator', 'altercpa', { person_id: ev.operator.person_id, ext: ev.operator.login });
  if (ev.operator?.proposal && on.has('login-names')) return stamp('login-names', 'altercpa', { person_id: ev.operator.proposal.person_id, ext: ev.operator.login });

  // 2. the order's own parcel
  if (trackings.length) {
    const e = ev['own-doc'];
    // The parcel is not this sale's (an older document, two authors, another department's or a web
    // parcel, held by another order): held WHATEVER sources are enabled — no source may credit a
    // sale through somebody else's parcel (02.10.2026: with own-doc off, the canceller used to take
    // two of these).
    if (PARCEL_HOLDS.includes(e.r)) return { ...out, outcome: 'hold', reason: e.r };
    // a parcel on a history import from before the MEX register (02.04.2026) was linked later, by phone:
    // its document names the AlterCPA decider in 19–30 % of the known cases (precision table) — never evidence
    if (e.ok && o.det === 'history' && out.period !== 'from_april') return { ...out, outcome: 'hold', reason: 'history_parcel_linked_later' };
    if (e.ok) return on.has('own-doc') ? stamp('own-doc', 'collabbox', author(e), { doc: e.doc }) : { ...out, outcome: 'unknown', reason: 'own_doc_not_enabled' };
    // the canceller only stands in for a document that is GONE (its precision: 91.5 % cancelled, 59.6 % trashed)
    if (e.r === 'parcel_document_gone' && ev.canceller && on.has('canceller')) return stamp('canceller', 'altercpa', ev.canceller);
    if (e.r === 'parcel_document_gone' && ev['canceller-trashed'] && on.has('canceller-trashed')) return stamp('canceller-trashed', 'altercpa', ev['canceller-trashed']);
    return { ...out, outcome: 'unknown', reason: e.r };
  }

  // 3. the customer's phone (amount ignored) — "the old ones" only: a sale from 02.04.2026 on (the MEX
  // register) that still has no parcel of its own is not the sale a document on its phone shipped
  // (the phone rule names the decider in 37–80 % of those, against 92–93 % before)
  if (out.period === 'from_april') {
    const why = !ev.operator ? 'no_operator' : !ev.operator.evidence ? `login_${ev.operator.login}_no_documents` : `login_${ev.operator.login}@${ev.operator.month}_not_one_person`;
    return { ...out, outcome: 'unknown', reason: `mex_era_sale_without_parcel · ${why}` };
  }
  const phone = PHONE_SOURCES.filter((s) => on.has(s)).map((s) => [s, ev[s]]);
  const amb = phone.find(([, e]) => e.ambiguous);
  if (amb) return { ...out, outcome: 'hold', reason: `${amb[0]}:${amb[1].r}` };
  const hits = phone.filter(([, e]) => e.ok);
  if (new Set(hits.map(([, e]) => e.author)).size > 1) return { ...out, outcome: 'hold', reason: 'phone_sources_disagree' };
  if (hits.length) return stamp(hits[0][0], 'collabbox', author(hits[0][1]), { doc: hits[0][1].doc });

  // 4. the 05.08 name matcher
  if (ev.corrections?.ok && on.has('corrections')) return stamp('corrections', 'collabbox', author(ev.corrections), { doc: ev.corrections.doc });
  if (ev.corrections?.ambiguous && on.has('corrections')) return { ...out, outcome: 'hold', reason: 'corrections:several_authors' };

  const why = !ev.operator ? 'no_operator'
    : !ev.operator.evidence ? `login_${ev.operator.login}_no_documents`
      : `login_${ev.operator.login}@${ev.operator.month}_not_one_person`;
  const last = phone.length ? phone[phone.length - 1][1].r : 'phone_sources_off';
  return { ...out, outcome: 'unknown', reason: `${last} · ${why}` };
}

// ─── precision on sales whose seller IS known ───────────────────────────────
async function precision(ctx) {
  const ref = await sqlRead(`select o.id, o.sale_source_detail as det, o.created_at, public.insights_phone8(o.customer_phone) as p8,
      o.mex_tracking_id as tr, o.external_order_id as ext_id, o.sold_by_person_id::text as pid, o.sold_via,
      exists (select 1 from public.mex_parcels mp where mp.order_id = o.id) as has_parcel
    from public.orders o
   where o.sale_source = 'altercpa' and o.sold_by_person_id is not null and o.sold_via in ('import', 'altercpa')`);
  // the documents the reference windows reach need their holders too
  const extra = [];
  for (const o of ref) {
    if (o.tr) { extra.push(o.tr); continue; }
    if (o.has_parcel) continue;
    for (const src of PHONE_SOURCES) for (const d of phoneDocs(src, o, ctx)) if (inWindow(o, d)) extra.push(d.doc);
  }
  const missing = [...new Set(extra)].filter((n) => !ctx.holders.has(n));
  for (const [k, v] of await loadHolders(missing)) ctx.holders.set(k, v);
  for (const n of missing) if (!ctx.holders.has(n)) ctx.holders.set(n, new Set());
  const t = {};
  const add = (k, o, who) => {
    t[k] ??= { found: 0, agree: 0, disagree: 0, unmapped: 0 };
    t[k].found++;
    if (!who) t[k].unmapped++; else if (who === o.pid) t[k].agree++; else t[k].disagree++;
  };
  const person = (e) => ctx.resolver.author(e.author).person_id ?? e.apid ?? null;
  for (const o of ref) {
    const per = periodOf(o.created_at);
    if (o.tr) {
      const d = ctx.docOf(o.tr);
      if (d?.author && LEAD_TYPES.has(d.tip)) add(`own-doc · ${o.det} · ${per}`, o, person(d));
      continue;
    }
    if (o.has_parcel) continue;
    for (const src of PHONE_SOURCES) {
      const e = phonePick(src, { ...o, id: o.id }, ctx);
      if (e.ok) add(`${src} · ${o.det} · ${per}`, o, person(e));
    }
    const corr = o.det === 'history' ? ctx.corrections.get(String(o.ext_id)) : null;
    if (corr?.length && new Set(corr.map((c) => c.author)).size === 1) add(`corrections · history · ${per}`, o, person(corr[0]));
  }
  const [c] = await sqlRead(`with c as (select distinct on (l.order_id) l.order_id, l.decision, l.decided_by_altercpa_user u, l.account_id
        from public.altercpa_leads l where l.order_id is not null order by l.order_id, l.last_seen_at desc, l.id)
    select count(*) filter (where c.decision = 'cancelled' and i.person_id is not null and d.author_person_id is not null)::int as c_n,
           count(*) filter (where c.decision = 'cancelled' and i.person_id = d.author_person_id)::int as c_agree,
           count(*) filter (where c.decision = 'trashed' and i.person_id is not null and d.author_person_id is not null)::int as t_n,
           count(*) filter (where c.decision = 'trashed' and i.person_id = d.author_person_id)::int as t_agree
      from c join public.orders o on o.id = c.order_id
      join public.collabbox_documents d on d.doc_number = o.mex_tracking_id and d.doc_type_id in ('10111', '10114')
      left join public.sales_person_identities i on i.kind = 'altercpa_user' and i.account_id = c.account_id and i.value = c.u::text
     where c.decision in ('cancelled', 'trashed')`);
  // login-names, validated on the logins the owner HAS named: the month's proposal vs the identity
  const lv = { found: 0, agree: 0, disagree: 0, unmapped: 0 };
  for (const l of ctx.logins.values()) {
    if (!l.month || !l.identity) continue;
    const ident = ctx.altUser.get(`${ctx.db.mkAccount}:${l.login}`);
    const p = proposalFor(ctx.logins, l.login, l.month, { ignoreIdentity: true });
    if (!p || !ident) continue;
    lv.found += l.docs;
    if (p.person_id === ident.person_id) lv.agree += l.docs; else lv.disagree += l.docs;
  }
  t['login-names · named logins (approvals in proposed months)'] = lv;
  t['canceller · bridge · (doc author known)'] = { found: c.c_n, agree: c.c_agree, disagree: c.c_n - c.c_agree, unmapped: 0 };
  t['canceller-trashed · bridge · (doc author known)'] = { found: c.t_n, agree: c.t_agree, disagree: c.t_n - c.t_agree, unmapped: 0 };
  const rows = Object.entries(t).sort().map(([k, v]) => ({ source: k, ...v,
    precision: v.agree + v.disagree ? `${((100 * v.agree) / (v.agree + v.disagree)).toFixed(1)}%` : '—' }));
  return rows;
}

// ─── the plan ───────────────────────────────────────────────────────────────
/**
 * Everything the sources look at, loaded once (read-only): the unresolved orders, the export, the
 * ledger, MEX, the AlterCPA order list, the corrections, people, and the holders of every document a
 * source may take. `ctx.opts.sources` is a placeholder — classify(o, { ...ctx, opts: { sources } }).
 * Also used by scripts/repair-legacy-no-seller.mjs (one load, two source sets).
 */
export async function loadEvidence({ collabDir = DEFAULT_COLLAB_DIR, dataDir = null } = {}) {
  const exp = loadExport(collabDir);
  ok(`collabBox export: ${exp.docs} documents (${exp.docsPath}, ${fmtSkopje(exp.mtime)}, sha ${exp.docsSha.slice(0, 12)}…), ${exp.phonesOf.size} komitenti with a phone`);
  const orders = (await sqlRead(candidatesSql())).map((o) => ({ ...o, parcels: typeof o.parcels === 'string' ? JSON.parse(o.parcels) : (o.parcels || []) }));
  ok(`${orders.length} sales the stamping cron leaves unresolved (order_decider_plan, 10 years)`);
  const db = await loadDb();
  const people = await loadPeople();
  const resolver = makeResolver(people);
  const rawPath = dataFile(dataDir, 'altercpa-mk-raw.jsonl');
  const corrPath = dataFile(dataDir, 'collabbox-corrections.csv');
  const alt = await loadAltercpaRaw(rawPath, new Set(orders.filter((o) => o.det === 'history').map((o) => String(o.ext_id))), exp);
  ok(`AlterCPA order list: ${alt.raw.size} of the history imports found (${rawPath}, sha ${alt.sha.slice(0, 12)}…)`);
  const corrections = loadCorrections(corrPath);
  const altUser = new Map(people.idents.filter((i) => i.kind === 'altercpa_user').map((i) => [`${i.account_id}:${i.value}`, i]));
  const logins = loginTallies(alt.tally, resolver, altUser, db.mkAccount);
  // every document number any source may take must have its holders loaded
  const ctx0 = buildContext({ exp, db, holders: new Map(), resolver, idents: people.idents, raw: alt.raw, corrections: corrections.by, logins, opts: { sources: new Set() } });
  const nums = [];
  for (const o of orders) {
    nums.push(o.tr, ...(o.parcels || []));
    for (const src of PHONE_SOURCES) for (const d of phoneDocs(src, o, ctx0)) if (inWindow(o, d)) nums.push(d.doc);
  }
  ctx0.holders = await loadHolders(nums);
  return {
    orders, ctx: ctx0, resolver, logins, tally: alt.tally,
    evidence: { export: { file: exp.docsPath, sha256: exp.docsSha, documents: exp.docs, komitenti_sha256: exp.komSha },
      altercpa_raw: { file: rawPath, sha256: alt.sha }, corrections: { file: corrPath, sha256: corrections.sha } },
  };
}

export async function buildPlan({ collabDir = DEFAULT_COLLAB_DIR, dataDir = null, sources = new Set(SOURCES), withPrecision = true, onlyOrders = null } = {}) {
  const { orders, ctx: base, resolver, logins, evidence } = await loadEvidence({ collabDir, dataDir });
  const ctx0 = { ...base, opts: { sources } };
  // --orders: only the listed sales may be stamped (the owner's corroborated list, 02.10.2026) — every
  // other row is classified as usual and reported, but left alone
  const rows = orders.map((o) => {
    const r = classify(o, ctx0);
    if (onlyOrders && !onlyOrders.has(o.display_id) && !onlyOrders.has(o.id)) return { ...r, outcome: 'skip', reason: `not_in_order_list (${r.outcome}${r.source ? ` ${r.source}` : ''})` };
    return r;
  });
  const stamps = rows.filter((r) => r.outcome === 'stamp');
  const lineOf = new Map(stamps.map((r) => [r.order_id, planLine(r.order_id, r.source, `${r.person_id || '-'}|${r.ext}|${r.via}|${r.sold_at}`, r.doc || '')]));
  const prec = withPrecision ? await precision(ctx0) : null;
  return {
    orders, rows, stamps, lines: [...lineOf.values()], lineOf, resolver, logins, prec, evidence,
  };
}

// ─── report ─────────────────────────────────────────────────────────────────
const PERIODS = ['before_march', 'march', 'from_april'];
function report({ rows, resolver, logins, prec }) {
  const groups = {};
  for (const r of rows) { groups[r.group] ??= { orders: 0, ден: 0 }; groups[r.group].orders++; groups[r.group].ден += r.value_mkd; }
  console.log(bold(`\n── The unresolved set, live: ${rows.length} sales ──`));
  printTable(Object.entries(groups).sort().map(([g, v]) => ({ group: g, orders: v.orders, ден: fmtMkd(v.ден) })));

  console.log(bold('\n── Resolved by source (first source that applies, precedence order) ──'));
  const by = {};
  for (const r of rows) {
    const k = r.outcome === 'stamp' ? `stamp · ${r.source}` : `${r.outcome} · ${r.reason}`;
    by[k] ??= { what: k, all: 0, with_person: 0, ...Object.fromEntries(PERIODS.map((p) => [p, 0])) };
    by[k].all++; by[k][r.period]++; if (r.person_id) by[k].with_person++;
  }
  printTable(Object.values(by).sort((a, b) => (a.what.startsWith('stamp') === b.what.startsWith('stamp') ? b.all - a.all : a.what.startsWith('stamp') ? -1 : 1)));

  console.log(bold('\n── What every source would say on its own (overlaps; disagreements with the chosen seller) ──'));
  const solo = {};
  const chosenPerson = new Map(rows.filter((r) => r.outcome === 'stamp').map((r) => [r.order_id, r.person_id]));
  for (const r of rows) {
    if (r.outcome === 'skip') continue;
    for (const [src, e] of Object.entries(r.ev)) {
      const s = (solo[src] ??= { source: src, names_one: 0, ambiguous: 0, no_evidence: 0, agrees_with_chosen: 0, disagrees_with_chosen: 0 });
      let who = null;
      if (src === 'operator') { if (e.person_id || e.proposal) { s.names_one++; who = e.person_id || e.proposal.person_id; } else s.no_evidence++; }
      else if (e.ok) { s.names_one++; who = e.person_id ?? resolver.author(e.author).person_id ?? e.apid ?? null; }
      else if (e.ambiguous) s.ambiguous++; else s.no_evidence++;
      const ch = chosenPerson.get(r.order_id);
      if (who && ch && who !== ch) s.disagrees_with_chosen++;
      if (who && ch && who === ch && r.source !== src) s.agrees_with_chosen++;
    }
  }
  printTable(Object.values(solo));

  console.log(bold(`\n── AlterCPA logins of this set → collabBox author per Skopje month (approvals tied to ONE document; a person = ≥ ${LOGIN_MIN_SHARE * 100} % of ≥ ${LOGIN_MIN_DOCS}) ──`));
  const needed = new Set(rows.map((r) => r.ev.operator?.login).filter(Boolean));
  const inSet = (login, month) => rows.filter((r) => r.ev.operator?.login === login && (!month || r.ev.operator.month === month)).length;
  printTable([...logins.values()].filter((l) => needed.has(l.login) && (!l.month || inSet(l.login, l.month)))
    .sort((a, b) => (a.login === b.login ? String(a.month ?? '').localeCompare(String(b.month ?? '')) : Number(a.login) - Number(b.login)))
    .map((l) => {
      const p = l.month ? proposalFor(logins, l.login, l.month) : null;
      return { login: l.login, month: l.month || 'all', orders_here: inSet(l.login, l.month), docs: l.docs, author: l.author,
        share: `${Math.round(100 * l.share)}%`, second: l.second, proposed: l.month ? (p ? `${p.author} (${p.basis})` : '—') : '' };
    }));
  const noEvidence = [...needed].filter((id) => !logins.has(id));
  if (noEvidence.length) console.log(`  logins with no tied document at all: ${noEvidence.map((id) => `#${id} (${rows.filter((r) => r.ev.operator?.login === id).length})`).join(', ')}`);

  if (prec) {
    console.log(bold('\n── Precision: on sales whose AlterCPA decider IS known, how often the source names the same person ──'));
    printTable(prec);
  }
  const st = rows.filter((r) => r.outcome === 'stamp');
  const per = new Map();
  for (const r of st) {
    const k = r.person_id ? resolver.person(r.person_id)?.display_name : `(no person) ${r.ext}`;
    per.set(k, (per.get(k) || 0) + 1);
  }
  console.log(bold('\nCredited — by seller'));
  printTable([...per].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([seller, orders]) => ({ seller, orders })));
}

// ─── main ───────────────────────────────────────────────────────────────────
function parseSources(s) {
  if (!s) return new Set(SOURCES);
  const set = new Set(String(s).split(',').map((x) => x.trim()).filter(Boolean));
  for (const x of set) if (!SOURCES.includes(x)) die(`--sources: unknown source "${x}" (known: ${SOURCES.join(', ')})`);
  return set;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'rollback', 'outside-quiet-window', 'no-precision', 'preview'],
    values: ['run', 'actor', 'chunk', 'collab-dir', 'data-dir', 'sources', 'orders'],
  });
  const APPLY = !!args.apply;
  mkGuard();
  console.log(bold(`\nSeller matching — ${KEY}`) + (APPLY ? yellow(' — APPLY') : ' — dry run'));
  await assertRemoteIsMk();
  await requireKeepUpdatedAt({ forApply: APPLY && !args.rollback });
  const [pre] = await sqlRead(`select to_regclass('public.data_repair_runs') is not null as runs,
      to_regprocedure('public.order_decider_plan(interval)') is not null as plan,
      to_regclass('public.collabbox_documents') is not null as ledger`);
  if (!pre.runs || !pre.plan || !pre.ledger) die('data_repair_runs / order_decider_plan / collabbox_documents missing.');
  if (args.rollback) return rollback(args);

  const sources = parseSources(args.sources);
  const options = { sources: SOURCES.filter((s) => sources.has(s)) };
  // --orders <file>: ORD-… display ids or uuids (whitespace / comma separated) — recorded, the apply repeats it
  const onlyOrders = args.orders ? new Set(readFileSync(args.orders, 'utf8').split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean)) : null;
  if (onlyOrders) options.orders = [...onlyOrders].sort();
  const collabDir = args['collab-dir'] || DEFAULT_COLLAB_DIR;
  const plan = await buildPlan({ collabDir, dataDir: args['data-dir'] || null, sources, withPrecision: !APPLY && !args['no-precision'], onlyOrders });
  if (onlyOrders) {
    const listed = plan.rows.filter((r) => onlyOrders.has(r.display_id) || onlyOrders.has(r.order_id));
    const missing = [...onlyOrders].filter((x) => !plan.rows.some((r) => r.display_id === x || r.order_id === x));
    const notStamped = listed.filter((r) => r.outcome !== 'stamp');
    ok(`--orders: ${onlyOrders.size} listed · ${listed.length} in the unresolved set · ${listed.length - notStamped.length} stamped by --sources`);
    if (missing.length) warn(`not in the cron's unresolved set (stamped meanwhile?): ${missing.join(', ')}`);
    if (notStamped.length) warn(`listed but no enabled source stamps them: ${notStamped.map((r) => `${r.display_id} (${r.outcome} ${r.reason || ''})`).join(', ')}`);
  }
  const { rows, stamps, lines, lineOf, resolver } = plan;
  report(plan);
  const csv = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, rows.map((r) => ({
    order: r.display_id, group: r.group, period: r.period, outcome: r.outcome, source: r.source || '', reason: r.reason || '',
    seller: r.person_id ? resolver.person(r.person_id)?.display_name : '', sold_by_ext: r.ext || '', sold_via: r.via || '',
    sold_at: r.sold_at ? fmtSkopje(r.sold_at) : '', status: r.status, bucket: r.bucket, value_mkd: r.value_mkd, tracking: r.tracking,
    doc: r.doc || '', altercpa: r.altercpa, operator_login: r.ev.operator?.login || '',
    evidence: Object.fromEntries(Object.entries(r.ev).map(([k, e]) => [k, e.ok ? `${e.author || e.ext}${e.doc ? ` ${e.doc}` : ''}` : (k === 'operator' ? `#${e.login}${e.proposal ? ` → ${e.proposal.author}` : ''}` : e.r)])),
  })));
  ok(`CSV (PII-free; stays in exports/): ${csv}`);

  const count = (f) => rows.filter(f).length;
  const bySource = {};
  for (const r of stamps) { bySource[r.source] ??= { all: 0, with_person: 0, ...Object.fromEntries(PERIODS.map((p) => [p, 0])) }; bySource[r.source].all++; bySource[r.source][r.period]++; if (r.person_id) bySource[r.source].with_person++; }
  const reasons = {};
  for (const r of rows.filter((x) => x.outcome !== 'stamp')) reasons[`${r.outcome}: ${r.reason}`] = (reasons[`${r.outcome}: ${r.reason}`] || 0) + 1;
  const summary = {
    script: 'repair-seller-matching.mjs', options, evidence: plan.evidence,
    counts: { population: rows.length, stamp: stamps.length, with_person: count((r) => r.outcome === 'stamp' && r.person_id),
      hold: count((r) => r.outcome === 'hold'), unknown: count((r) => r.outcome === 'unknown'), skip: count((r) => r.outcome === 'skip') },
    by_source: bySource, not_stamped: reasons,
    login_proposals: Object.values(Object.fromEntries(rows.filter((r) => r.source === 'login-names').map((r) => {
      const p = r.ev.operator.proposal;
      return [`${r.ev.operator.login}|${r.ev.operator.month}`, { login: r.ev.operator.login, month: r.ev.operator.month, author: p.author,
        share: Math.round(100 * p.share), docs: p.docs, basis: p.basis }];
    }))),
    precision: plan.prec, csv: csv.split(/[\\/]/).pop(),
  };

  if (!APPLY) {
    if (!lines.length) { console.log(bold('\nNothing to stamp — no run recorded.\n')); return; }
    if (args.preview) { console.log(bold(`\nPreview only (--preview): ${lines.length} orders would be stamped; no run recorded.\n`)); return; }
    const { id, hash } = await recordDryRun({ key: KEY, lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…, ${lines.length} orders; sources ${options.sources.join(',')})`);
    console.log('Nothing was written to orders. After the owner approves the sources, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-seller-matching.mjs --apply --run ${id} --sources ${options.sources.join(',')}${args.orders ? ` --orders "${args.orders}"` : ''}\n`);
    return;
  }

  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines, options });
  const byId = new Map(plan.orders.map((o) => [o.id, o]));
  const items = stamps.filter((r) => !done.has(r.order_id)).map((r) => ({
    order_id: r.order_id, rule: r.source, via: r.via, sold_at: r.sold_at, person_id: r.person_id, ext: r.ext,
    status: byId.get(r.order_id).status, expect_tracking: byId.get(r.order_id).tr, line: lineOf.get(r.order_id),
    evidence: { source: r.source, doc: r.doc || null, period: r.period, operator_login: r.ev.operator?.login ?? null },
  }));
  console.log(bold(`\nStamping ${items.length} orders`));
  const stats = await applyChunked({ items, build: (chunk) => buildStampChunkSql({ runId: args.run, rows: chunk }), chunkSize: Number(args.chunk) || MAX_CHUNK });
  const payload = { script: 'repair-seller-matching.mjs', options, counts: summary.counts, applied_orders: stats.applied,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size, outside_quiet_window: !!args['outside-quiet-window'] };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger. Re-run the same --apply to resume.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders stamped${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);
  const [v] = await sqlRead(`select count(*)::int as ledger_rows,
      count(*) filter (where (r.after->>'updated_at')::timestamptz is distinct from (r.before->>'updated_at')::timestamptz)::int as updated_at_moved
    from public.data_repair_rows r where r.run_id = ${qUuid(args.run)} and r.after is not null`);
  printTable([v]);
  if (v.updated_at_moved) warn(`${v.updated_at_moved} order(s) had updated_at moved — the keep_updated_at guard did not hold.`);
  console.log(yellow('  Next: node scripts/verify-stamp-parity.mjs (the stamped rows leave the cron\'s unresolved list) and the Agents tab.\n'));
}

async function rollback(args) {
  if (!isUuid(args.run)) die('--rollback needs --run <the applied run id>');
  const [run] = await sqlRead(`select id, key, applied_at from public.data_repair_runs where id = ${qUuid(args.run)}`);
  if (!run || run.key !== KEY) die(`run ${args.run} is not a ${KEY} run.`);
  if (!run.applied_at) die(`run ${args.run} was never applied — nothing to roll back.`);
  const rows = await sqlRead(`select order_id from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null`);
  const ids = rows.map((r) => r.order_id);
  console.log(bold(`\nRollback of ${args.run}: ${ids.length} stamped orders`) + (args.apply ? yellow(' — APPLY') : ' — preview (pass --apply)'));
  if (!args.apply || !ids.length) return;
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the rollback');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  const rbKey = `rollback-${KEY}`;
  const rbRunId = randomUUID();
  await sql(`insert into public.data_repair_runs (id, key, dry_run, candidate_hash, summary)
    values (${qUuid(rbRunId)}, ${q(rbKey)}, false, ${q(candidateHash(ids))}, ${qJson({ rolled_back_run: args.run, orders: ids.length })})`);
  const stats = await applyChunked({ items: ids, build: (chunk) => buildRollbackChunkSql({ runId: args.run, rbRunId, orderIds: chunk }), label: 'orders' });
  const payload = { rolled_back_run: args.run, restored: stats.applied, skipped_changed: stats.skipped, chunks: `${stats.committed}/${stats.chunks}` };
  if (stats.failed) {
    await auditPartial({ key: rbKey, runId: rbRunId, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; re-run to continue (restored rows are no longer equal to after and are skipped).`);
  }
  await finalizeRun({ key: rbKey, runId: rbRunId, actor, payload });
  ok(`rolled back ${stats.applied} stamps (${stats.skipped.length} changed since and left alone) — run ${rbRunId}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
