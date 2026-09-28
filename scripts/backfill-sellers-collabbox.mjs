/**
 * Backfill — WHO SOLD the sales the Agents tab credits to nobody (owner question 28.09.2026:
 * "Can't we find who sold them?"). No shebang (repair-kit convention). Run with `node`.
 *
 *   node scripts/backfill-sellers-collabbox.mjs                        # DRY RUN: classify → CSV → data_repair_runs row → run id
 *   node scripts/backfill-sellers-collabbox.mjs --apply --run <id>     # stamp (quiet window, same flags as the dry run)
 *        [--actor mile@elyon.com] [--chunk 200] [--outside-quiet-window]
 *   node scripts/backfill-sellers-collabbox.mjs --rollback --run <id> [--apply]   # undo one applied run
 *   options (recorded; the apply must repeat them):
 *     --collab-dir <dir>       the local collabBox harvest (default C:\Users\Mile\collab_out:
 *                              orders/orders_combined.csv + komitenti_full.csv) — read-only evidence
 *     --no-phone-rule          skip rule 4 (collabbox_phone)
 *     --hold-self-cancelled    do NOT credit an author who is also the operator that cancelled /
 *                              trashed the same lead in AlterCPA (listed as held instead)
 *
 * ── WHICH ORDERS ─────────────────────────────────────────────────────────────
 * A sale the cohort counts (cohort_in_total(cohort_order_bucket(…)), MEX-first) that has NO
 * sold_at, and that the live stamping cron cannot resolve: order_decider_plan(10 years) says
 * `unresolved` — plus the orders the plan never lists because their CRM status is
 * cancelled/trashed while MEX moves their parcel (the cohort still counts them). Never a
 * duplicated copy, a disposition row, a synthetic product or a test phone. The cron's own
 * `stamp` rows (AlterCPA approvals, CRM decisions, imports) are left to the cron.
 * September 2026: 928 such sales (Agents tab, "altercpa_cancelled"); all history ≈ 5.5k.
 *
 * ── WHO SOLD IT — first rule that applies (evidence, strongest first) ────────
 *   collabbox_doc    the collabBox document whose DocNumber = the order's MEX tracking id
 *                    (orders.mex_tracking_id, or a parcel the register links to the order):
 *                    its Avtor raised the shipment.                     sold_via collabbox
 *   crm_confirm      a person's (not 'System (…)', not an annotated '… — …' row) order_history
 *                    transition INTO confirmed — a CRM sale decision.   sold_via crm
 *   crm_push         a real (non-noop) APPROVAL push to AlterCPA (params.accept = '1'): the
 *                    agent its comment names ("Agent: <name> — …") — NEVER the manager who
 *                    pressed the button.                                sold_via crm_push
 *   collabbox_phone  an order with NO parcel at all (the 2025-26 history imports): exactly one
 *                    collabBox Нарачка LEADS / LEADS-OUT author among the documents on the same
 *                    phone (last 8; KomitentID → komitenti Telefon/Mobilen) dated 24 h before …
 *                    10 days after the order, whose amount fits price × 61,5 (±3 ден, or +150
 *                    delivery ±3 — the kit's codFit), no order / parcel / web order / other
 *                    candidate holds that document, and no OTHER sale on the phone could own it
 *                    (same price, no parcel, ±10 days — duplicate history rows). sold_via collabbox
 * Authors resolve to people through sales_person_identities EXACTLY as the cron does
 * (collabbox_author, then order_name) — compared with runs of whitespace collapsed, because the
 * DB spellings carry double spaces the CSV does not ("Анита  Колигова"). sold_by_ext is the
 * identity's stored spelling when one matches, else the spelling already stamped on collabBox
 * orders, else the CSV Avtor — so naming a person later in Settings → Teams back-stamps them
 * (sales_backstamp_orders, kind collabbox_author, sold_via collabbox). Unmapped authors are
 * stamped with sold_by_ext and a NULL person (the "unmapped" queue), like the cron.
 * The AlterCPA operator who cancelled the lead is never used as evidence. When the document
 * author IS that operator (the common case — see the dry-run report), the author is still
 * credited, because the document proves they raised the shipment; --hold-self-cancelled
 * holds those instead.
 *
 * HELD (listed, never stamped): doc_conflict (two documents, two authors) · channel_mismatch
 * (an AlterCPA / CRM order on a NATURA teleshop/social document, series 9100/9102/9108 — the
 * link is suspect, cod-price's suspect_link) · doc_predates_order (the document is > 48 h older
 * than the order: an earlier sale's parcel) · parcel_shared (another order holds the tracking id).
 * UNKNOWN (why): doc_after_export (the tracking number is past the export's last document of
 * its series — the harvest ends 10.09.2026 for LEADS) · doc_not_in_export · non_collabbox_parcel
 * · and, for orders without a parcel, the phone rule's failure.
 *
 * ── sold_at ──────────────────────────────────────────────────────────────────
 * The cohort's sale day is coalesce(sold_at, AlterCPA approval, confirmed_at, created_at); for
 * these orders today it is created_at (or confirmed_at). sold_at = the evidence time (document
 * Datum, Skopje local → UTC; the transition / push time) when it falls in the SAME Skopje month
 * as that current sale day, else the current sale day itself, unchanged. Dry run 28.09 (run
 * 2f94aa0f, 3.906 stamps): 2.927 same day, 887 move inside their month (673 by one day), 92
 * would cross a month end (54 Aug → Sept, lags up to 67 days) — those keep their day. So no
 * monthly total, and not September's 928, moves; daily boards get the real booking day.
 *
 * ── APPLY (repair-kit protocol) ──────────────────────────────────────────────
 * Re-classify, refuse unless the hash equals the dry run's; then ≤ 200-order transactions, each:
 * SET LOCAL elyon.bulk_repair = 'on' + elyon.keep_updated_at = 'on' (updated_at is Call Again's
 * last_call_at — it must not move), lock FOR NO KEY UPDATE, keep only orders still unstamped
 * with the planned status + tracking id, data_repair_rows.before → UPDATE sold_* (NULL → value
 * only; the write-once trigger stays on) → verify → after. No order_history / order_notes row:
 * a bookkeeping stamp, like the stamping cron. Then applied_at + one audit_log row.
 * --rollback clears the stamps of one run (only where they still equal the after-image; a
 * person filled since by Settings → Teams is tolerated) under elyon.allow_sold_change = 'on'.
 *
 * 🛑 MACEDONIA ONLY (repair-kit guards). The collabBox files are read, never written.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import {
  MAX_CHUNK, MKD_PER_EUR, bold, green, yellow, die, warn, ok,
  mkGuard, sql, sqlRead, assertRemoteIsMk, requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
  q, qUuid, qUuidArray, qTextArray, qJson, parseArgs, fmtSkopje, fmtMkd, fileStamp, writeCsv, printTable,
  planLine, candidateHash, recordDryRun, verifyRunForApply, applyChunked, finalizeRun, auditPartial, resolveActor,
  isUuid, codFit,
} from './lib/repair-kit.mjs';

export const KEY = 'sellers-collabbox';
const REAL = ['confirmed', 'shipped', 'delivered', 'paid', 'returned'];
const DEFAULT_COLLAB_DIR = 'C:/Users/Mile/collab_out';
/** Нарачка LEADS (9110) · LEADS-OUT Нарачка (9103) — the BIO NATURAL lead documents. */
const LEAD_TYPES = new Set(['10111', '10114']);
/** NATURA teleshop / social series — never an AlterCPA lead's parcel (cod-price suspect_link). */
const TELESHOP_SERIES = new Set(['9100', '9102', '9108']);
const PHONE_BEFORE_H = 24;
const PHONE_AFTER_H = 240;
const PREDATES_H = 48;
const H = 3_600_000;

const ws = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const docRe = /^(\d{3})-(\d{4})-(\d+)\/(\d{4})$/;

// ─── collabBox evidence (local, read-only) ──────────────────────────────────
export function parseCsv(text) {
  const rows = [];
  let f = '', row = [], quoted = false;
  text = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else quoted = false; } else f += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f.replace(/\r$/, '')); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const head = rows.shift() || [];
  return rows.filter((r) => r.length > 1).map((r) => Object.fromEntries(head.map((k, j) => [k, r[j]])));
}

const SKOPJE_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Skopje', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
/** collabBox "dd.mm.yyyy hh:mm:ss" is Skopje wall time → a UTC Date (DST-aware). */
export function skopjeLocalToUtc(s) {
  const m = String(s || '').match(/^(\d{2})\.(\d{2})\.(\d{4}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const guess = Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  const p = Object.fromEntries(SKOPJE_PARTS.formatToParts(new Date(guess)).map((x) => [x.type, x.value]));
  const offset = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - guess;
  return new Date(guess - offset);
}
const SKOPJE_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Skopje' });
export const skopjeDay = (v) => SKOPJE_DAY.format(new Date(v));
export const skopjeMonth = (v) => skopjeDay(v).slice(0, 7);

export function loadCollab(dir) {
  const ordersPath = join(dir, 'orders', 'orders_combined.csv');
  const komPath = join(dir, 'komitenti_full.csv');
  const raw = readFileSync(ordersPath);
  const fileSha = createHash('sha256').update(raw).digest('hex');
  const docs = parseCsv(raw.toString('utf8')).map((d) => ({
    doc: d.DocNumber, tip: d.TipID, tipName: d.Tip, komitent: d.KomitentID,
    amount: Number(String(d.Iznos ?? '').replace(/,/g, '')), datum: d.Datum, at: skopjeLocalToUtc(d.Datum), author: d.Avtor,
  })).filter((d) => d.doc && d.at);
  const byNum = new Map();
  const seriesMax = new Map();   // 'series/year' → highest document number in the export
  const typeEnd = new Map();     // TipID → last document time
  for (const d of docs) {
    (byNum.get(d.doc) ?? byNum.set(d.doc, []).get(d.doc)).push(d);
    const m = d.doc.match(docRe);
    if (m) { const k = `${m[2]}/${m[4]}`; if (!seriesMax.has(k) || +m[3] > seriesMax.get(k)) seriesMax.set(k, +m[3]); }
    if (!typeEnd.has(d.tip) || d.at > typeEnd.get(d.tip).at) typeEnd.set(d.tip, { at: d.at, name: d.tipName });
  }
  const phonesOf = new Map();
  for (const k of parseCsv(readFileSync(komPath, 'utf8'))) {
    const ps = [...new Set([k.Telefon, k.Mobilen].map((x) => String(x ?? '').replace(/\D/g, '').slice(-8)).filter((x) => x.length === 8))];
    if (ps.length) phonesOf.set(k.Sifra, ps);
  }
  const leadDocsByP8 = new Map();
  for (const d of docs) {
    if (!LEAD_TYPES.has(d.tip)) continue;
    for (const p of phonesOf.get(d.komitent) || []) (leadDocsByP8.get(p) ?? leadDocsByP8.set(p, []).get(p)).push(d);
  }
  return { ordersPath, fileSha, docs: docs.length, byNum, seriesMax, typeEnd, leadDocsByP8, komitenti: phonesOf.size };
}

// ─── loaders (read-only) ────────────────────────────────────────────────────
export function candidatesSql() {
  const real = REAL.map((s) => `'${s}'`).join(', ');
  return `
with ex as (select public.report_excluded_phone8s() as p8s),
p as materialized (
  select order_id, bucket from public.order_decider_plan(interval '10 years') where action = 'unresolved'
),
extra as materialized (       -- CRM says cancelled/trashed, MEX moves the parcel: a cohort sale the plan never lists
  select o.id as order_id, null::text as bucket from public.orders o
   where o.sold_at is null and o.mex_tracking_id is not null
     and o.status::text in ('cancelled', 'trashed')
     and not exists (select 1 from p where p.order_id = o.id)
),
c as (select * from p union all select * from extra)
select o.id, o.display_id, o.status::text as status, o.sale_source, o.sale_source_detail as det,
       o.created_at, o.confirmed_at, o.price, o.mex_tracking_id as tr, o.mex_status_id, o.mex_cod_mkd,
       public.insights_phone8(o.customer_phone) as p8,
       c.bucket as plan_bucket, b.bucket as cohort_bucket, public.cohort_in_total(b.bucket) as in_total,
       coalesce(la.decided_at, o.confirmed_at, o.created_at)::text as cohort_sale_at,
       public.insights_excluded8(public.insights_phone8(o.customer_phone), ex.p8s) as test_phone,
       l.decision, l.decided_by_altercpa_user as canceller, l.account_id as lead_account,
       (select coalesce(json_agg(mp.tracking_id order by mp.tracking_id), '[]'::json)
          from public.mex_parcels mp where mp.order_id = o.id) as parcels
  from c
  join public.orders o on o.id = c.order_id
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
 where o.sold_at is null
   and o.status::text <> 'duplicated'
   and o.sale_source_detail is distinct from 'disposition'
   and not public.is_synthetic_product_name(o.product_name)
   and (o.status::text in (${real}) or o.mex_tracking_id is not null or c.bucket is not null)`;
}

async function loadPeople() {
  const idents = await sqlRead(`select i.kind, i.value, i.account_id, i.person_id, sp.display_name, sp.is_manager, sp.user_id
    from public.sales_person_identities i join public.sales_people sp on sp.id = i.person_id`);
  const people = await sqlRead(`select id, display_name, is_manager, user_id from public.sales_people`);
  const cbxExt = await sqlRead(`select distinct sold_by_ext as ext from public.orders where sold_via = 'collabbox' and sold_by_ext is not null`);
  return { idents, people, cbxExt: cbxExt.map((r) => r.ext) };
}

async function loadCrmEvidence(ids) {
  const real = REAL.map((s) => `'${s}'`).join(', ');
  const hist = []; const push = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const part = qUuidArray(ids.slice(i, i + 1000));
    hist.push(...await sqlRead(`select h.order_id, h.changed_by, h.changed_by_name, h.changed_at::text as changed_at
        from public.order_history h
       where h.order_id = any(${part})
         and h.to_status::text = 'confirmed'
         and (h.from_status is null or h.from_status::text not in (${real}))
         and (h.changed_by is not null or h.changed_by_name is not null)
         and coalesce(h.changed_by_name, '') not like 'System (%'
         and coalesce(h.changed_by_name, '') not like '% — %'
       order by h.order_id, h.changed_at, h.id`));
    push.push(...await sqlRead(`select a.target_id as order_id, a.created_at::text as created_at,
             nullif(btrim(split_part(substring(a.payload -> 'params' ->> 'comment' from '^Agent: (.*)$'), ' — ', 1)), '') as agent
        from public.audit_log a
       where a.target_type = 'order' and a.action = 'order.altercpa_push'
         and a.target_id = any(${qTextArray(ids.slice(i, i + 1000))})
         and (a.payload ->> 'noop') is distinct from 'true'
         and a.payload -> 'params' ->> 'accept' = '1'
       order by a.created_at`));
  }
  return { hist, push };
}

/** Who else holds a tracking id: an order naming it, the register linking it, a live web order. */
async function loadHolders(trackings) {
  const out = new Map();
  const add = (tr, who) => (out.get(tr) ?? out.set(tr, new Set()).get(tr)).add(who);
  const list = [...new Set(trackings)].filter(Boolean);
  for (let i = 0; i < list.length; i += 1000) {
    const arr = qTextArray(list.slice(i, i + 1000));
    for (const r of await sqlRead(`select mex_tracking_id as tr, id::text as who from public.orders where mex_tracking_id = any(${arr})
        union all select tracking_id, order_id::text from public.mex_parcels where tracking_id = any(${arr}) and order_id is not null
        union all select mex_tracking_id, 'web:' || shop_order_id::text from public.web_orders where mex_tracking_id = any(${arr}) and deleted_in_shop_at is null`)) add(r.tr, r.who);
  }
  return out;
}

/** Rule-4 orders that have another real sale on the same phone, same price, no parcel, ±10 days. */
async function loadPhoneCompetitors(ids) {
  const real = REAL.map((s) => `'${s}'`).join(', ');
  const out = [];
  for (let i = 0; i < ids.length; i += 1000) {
    out.push(...(await sqlRead(`select o.id from public.orders o
       where o.id = any(${qUuidArray(ids.slice(i, i + 1000))})
         and exists (select 1 from public.orders o2
                      where o2.id <> o.id and o2.price = o.price and o2.mex_tracking_id is null
                        and o2.status::text in (${real})
                        and public.insights_phone8(o2.customer_phone) = public.insights_phone8(o.customer_phone)
                        and o2.created_at between o.created_at - interval '10 days' and o.created_at + interval '10 days')`)).map((r) => r.id));
  }
  return out;
}

// ─── classification (pure) ──────────────────────────────────────────────────
export function makeResolver({ idents, people, cbxExt }) {
  const cbx = new Map(); const on = new Map(); const alt = new Map(); const byUser = new Map(); const pp = new Map();
  for (const i of idents) {
    if (i.kind === 'collabbox_author' && !cbx.has(ws(i.value))) cbx.set(ws(i.value), i);
    if (i.kind === 'order_name' && !on.has(ws(i.value))) on.set(ws(i.value), i);
    if (i.kind === 'altercpa_user') alt.set(`${i.account_id}:${i.value}`, i);
  }
  for (const p of people) { pp.set(p.id, p); if (p.user_id) byUser.set(p.user_id, p); }
  const dbSpelling = new Map(cbxExt.map((e) => [ws(e), e]));
  const exactOn = new Map(idents.filter((i) => i.kind === 'order_name').map((i) => [i.value, i]));
  return {
    person: (id) => pp.get(id),
    /** collabBox author → { person_id, ext } (collabbox_author first, then order_name). */
    author(a) {
      const id = cbx.get(ws(a)) || on.get(ws(a));
      return { person_id: id?.person_id ?? null, ext: id ? id.value : (dbSpelling.get(ws(a)) || ws(a)) };
    },
    /** a CRM row: the login first, else the exact order_name (as the cron). */
    crm(userId, name) {
      const p = userId ? byUser.get(userId) : null;
      const id = !p && name ? exactOn.get(name) : null;
      return { person_id: p?.id ?? id?.person_id ?? null, ext: name || userId };
    },
    pushAgent(name) { const id = exactOn.get(name); return { person_id: id?.person_id ?? null, ext: name }; },
    canceller(accountId, user) { return user == null ? null : alt.get(`${accountId}:${user}`) ?? null; },
  };
}

function soldAtFor(evidenceAt, cohortRaw) {
  const cohort = new Date(cohortRaw);
  if (evidenceAt && skopjeMonth(evidenceAt) === skopjeMonth(cohort)) {
    return { sold_at: new Date(evidenceAt).toISOString(), basis: skopjeDay(evidenceAt) === skopjeDay(cohort) ? 'evidence_same_day' : 'evidence_moved_in_month' };
  }
  return { sold_at: cohortRaw, basis: 'cohort_day_kept' };
}

/**
 * One order → { outcome: stamp | hold | unknown, rule, via, person_id, ext, sold_at, … }.
 * `ctx`: { collab, resolver, hist: Map, push: Map, holders: Map, opts }.
 */
export function classify(o, ctx) {
  const { collab, resolver, opts } = ctx;
  const trackings = [...new Set([o.tr, ...(o.parcels || [])].filter(Boolean))];
  const base = {
    order_id: o.id, display_id: o.display_id, status: o.status, source: `${o.sale_source}/${o.det}`,
    bucket: o.cohort_bucket, cohort_day: skopjeDay(o.cohort_sale_at), tracking: trackings.join(' '),
    value_mkd: o.cohort_bucket && o.tr && Number(o.mex_cod_mkd) > 0 ? Number(o.mex_cod_mkd) : Math.round(Number(o.price || 0) * MKD_PER_EUR),
    altercpa: o.decision ? `${o.decision} by #${o.canceller ?? '?'}` : '',
  };
  const canc = (o.decision === 'cancelled' || o.decision === 'trashed') ? resolver.canceller(o.lead_account, o.canceller) : null;
  const finish = (rule, via, who, evidenceAt, extra = {}) => {
    const s = soldAtFor(evidenceAt, o.cohort_sale_at);
    const self = !!(canc && who.person_id && canc.person_id === who.person_id);
    const out = { ...base, outcome: 'stamp', rule, via, person_id: who.person_id, ext: who.ext, sold_at: s.sold_at, sold_at_basis: s.basis,
      evidence_at: evidenceAt ? new Date(evidenceAt).toISOString() : null, canceller_person: canc?.display_name ?? '', author_cancelled_in_altercpa: self, ...extra };
    if (self && opts.holdSelfCancelled) return { ...out, outcome: 'hold', reason: 'author_cancelled_in_altercpa' };
    return out;
  };
  const hold = (reason, extra = {}) => ({ ...base, outcome: 'hold', reason, ...extra });
  const unknown = (reason, extra = {}) => ({ ...base, outcome: 'unknown', reason, canceller_person: canc?.display_name ?? '', ...extra });

  // 1. the collabBox document of the order's own parcel
  const docs = trackings.flatMap((t) => collab.byNum.get(t) || []).sort((a, b) => a.at - b.at);
  if (docs.length) {
    const d = docs[0];
    const docInfo = { doc: d.doc, doc_type: d.tipName, doc_at: d.datum, author: d.author };
    if (new Set(docs.map((x) => ws(x.author))).size > 1) return hold('doc_conflict', docInfo);
    const series = d.doc.match(docRe)?.[2];
    if (o.sale_source !== 'collabbox' && (TELESHOP_SERIES.has(series) || !LEAD_TYPES.has(d.tip))) return hold('channel_mismatch', docInfo);
    if (d.at.getTime() < new Date(o.created_at).getTime() - PREDATES_H * H) return hold('doc_predates_order', docInfo);
    const others = [...(ctx.holders.get(d.doc) || [])].filter((w) => w !== o.id);
    if (others.length) return hold('parcel_shared', docInfo);
    return finish('collabbox_doc', 'collabbox', resolver.author(d.author), d.at, docInfo);
  }
  // 2. a person's CRM sale decision
  const h = ctx.hist.get(o.id);
  if (h) return finish('crm_confirm', 'crm', resolver.crm(h.changed_by, h.changed_by_name), h.changed_at);
  // 3. an approval push naming the deciding agent
  const p = ctx.push.get(o.id);
  if (p) return finish('crm_push', 'crm_push', resolver.pushAgent(p.agent), p.created_at);
  // 4. no parcel at all: the one LEADS author on this phone, amount and days
  if (trackings.length) {
    const m = trackings[0].match(docRe);
    if (!m) return unknown('non_collabbox_parcel');
    const max = collab.seriesMax.get(`${m[2]}/${m[4]}`);
    return unknown(max != null && +m[3] > max ? 'doc_after_export' : 'doc_not_in_export');
  }
  if (!opts.phoneRule) return unknown('no_parcel');
  const pick = ctx.phonePick.get(o.id);
  if (pick.ok) return finish('collabbox_phone', 'collabbox', resolver.author(pick.doc.author), pick.doc.at,
    { doc: pick.doc.doc, doc_type: pick.doc.tipName, doc_at: pick.doc.datum, author: pick.doc.author });
  return unknown(pick.reason);
}

/** Rule 4's document for each parcel-less order (two passes: a document two orders fit is nobody's). */
export function phonePicks(orders, collab) {
  const picks = new Map();
  for (const o of orders) {
    if (o.tr || (o.parcels || []).length) continue;
    if (!o.p8 || String(o.p8).length !== 8) { picks.set(o.id, { ok: false, reason: 'no_parcel_no_phone' }); continue; }
    const t0 = new Date(o.created_at).getTime();
    const cands = collab.leadDocsByP8.get(o.p8) || [];
    if (!cands.length) { picks.set(o.id, { ok: false, reason: 'no_parcel_no_doc_for_phone' }); continue; }
    const win = cands.filter((d) => d.at.getTime() >= t0 - PHONE_BEFORE_H * H && d.at.getTime() <= t0 + PHONE_AFTER_H * H);
    if (!win.length) { picks.set(o.id, { ok: false, reason: 'no_parcel_no_doc_in_window' }); continue; }
    const fit = win.filter((d) => codFit(o.price, d.amount)).sort((a, b) => a.at - b.at);
    if (!fit.length) { picks.set(o.id, { ok: false, reason: 'no_parcel_amount_differs' }); continue; }
    if (new Set(fit.map((d) => ws(d.author))).size > 1) { picks.set(o.id, { ok: false, reason: 'no_parcel_several_authors' }); continue; }
    picks.set(o.id, { ok: true, doc: fit[0] });
  }
  const claims = new Map();
  for (const [id, p] of picks) if (p.ok) (claims.get(p.doc.doc) ?? claims.set(p.doc.doc, []).get(p.doc.doc)).push(id);
  for (const ids of claims.values()) if (ids.length > 1) for (const id of ids) picks.set(id, { ok: false, reason: 'no_parcel_doc_fits_two_orders' });
  return picks;
}

// ─── SQL (apply / rollback) ─────────────────────────────────────────────────
const soldSnapshotSql = (o) => `jsonb_build_object('kind', 'sold', 'sold_at', ${o}.sold_at, 'sold_by_person_id', ${o}.sold_by_person_id,
    'sold_via', ${o}.sold_via, 'sold_by_ext', ${o}.sold_by_ext, 'status', ${o}.status::text,
    'mex_tracking_id', ${o}.mex_tracking_id, 'updated_at', ${o}.updated_at)`;

export function buildStampChunkSql({ runId, rows }) {
  if (!rows.length) throw new Error('empty chunk');
  if (rows.length > MAX_CHUNK) throw new Error(`chunk of ${rows.length} > ${MAX_CHUNK}`);
  const values = rows.map((r) => `(${[
    qUuid(r.order_id), q(r.rule), q(r.via), `${q(r.sold_at)}::timestamptz`, qUuid(r.person_id ?? null), q(r.ext),
    q(r.status), q(r.expect_tracking ?? null), qJson({ ...r.evidence, line: r.line }),
  ].join(', ')})`);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _plan (
  order_id uuid primary key, rule text not null, via text not null, sold_at timestamptz not null, person_id uuid,
  ext text not null, expect_status text not null, expect_tracking text, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

select count(*) from (select 1 from public.orders where id in (select order_id from _plan) order by id for no key update) l;

-- only orders still unstamped, in the status and on the parcel the plan saw
create temp table _ok on commit drop as
select p.* from _plan p join public.orders o on o.id = p.order_id
 where o.sold_at is null and o.sold_by_person_id is null and o.sold_via is null and o.sold_by_ext is null
   and o.status::text = p.expect_status
   and o.mex_tracking_id is not distinct from p.expect_tracking
   and (p.person_id is null or exists (select 1 from public.sales_people sp where sp.id = p.person_id));

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, k.order_id, k.rule, ${soldSnapshotSql('o')}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;

update public.orders o
   set sold_at = k.sold_at, sold_by_person_id = k.person_id, sold_via = k.via, sold_by_ext = k.ext
  from _ok k
 where o.id = k.order_id and o.sold_at is null;

do $chk$
declare n int;
begin
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id
   where o.sold_at is distinct from k.sold_at or o.sold_via is distinct from k.via
      or o.sold_by_ext is distinct from k.ext or o.sold_by_person_id is distinct from k.person_id;
  if n > 0 then raise exception 'sellers: % order(s) did not take their stamp', n; end if;
end $chk$;

update public.data_repair_rows r set after = ${soldSnapshotSql('o')}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

export function buildRollbackChunkSql({ runId, rbRunId, orderIds }) {
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local elyon.allow_sold_change = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _rb on commit drop as
select r.order_id, r.rule, r.after from public.data_repair_rows r
 where r.run_id = ${qUuid(runId)} and r.after is not null and r.after->>'kind' = 'sold'
   and r.order_id = any(${qUuidArray(orderIds)});

select count(*) from (select 1 from public.orders where id in (select order_id from _rb) order by id for no key update) l;

-- only stamps nobody changed since (a person filled by Settings → Teams is tolerated)
create temp table _eq on commit drop as
select b.* from _rb b join public.orders o on o.id = b.order_id
 where o.sold_at is not distinct from (b.after->>'sold_at')::timestamptz
   and o.sold_via is not distinct from b.after->>'sold_via'
   and o.sold_by_ext is not distinct from b.after->>'sold_by_ext'
   and (b.after->>'sold_by_person_id' is null or o.sold_by_person_id = (b.after->>'sold_by_person_id')::uuid);

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(rbRunId)}, e.order_id, 'rollback:' || e.rule, ${soldSnapshotSql('o')},
       jsonb_build_object('rolled_back_run', ${q(runId)}, 'line', e.order_id::text || ':rollback')
  from _eq e join public.orders o on o.id = e.order_id;

update public.orders o
   set sold_at = null, sold_by_person_id = null, sold_via = null, sold_by_ext = null
  from _eq e where o.id = e.order_id;

update public.data_repair_rows r set after = ${soldSnapshotSql('o')}
  from _eq e join public.orders o on o.id = e.order_id
 where r.run_id = ${qUuid(rbRunId)} and r.order_id = e.order_id and r.after is null;

select (select count(*) from _rb)::int as planned, (select count(*) from _eq)::int as applied,
       (select coalesce(jsonb_agg(b.order_id), '[]'::jsonb) from _rb b
         where not exists (select 1 from _eq e where e.order_id = b.order_id)) as skipped;`;
}

// ─── report ─────────────────────────────────────────────────────────────────
const inSept = (r) => r.cohort_day >= '2026-09-01' && r.cohort_day <= '2026-09-30';
function coverage(rows, resolver) {
  const t = { total: rows.length, credited_person: 0, credited_no_person: 0, held: 0, unknown: 0 };
  const byRule = {}; const why = {};
  for (const r of rows) {
    if (r.outcome === 'stamp') {
      if (r.person_id) t.credited_person++; else t.credited_no_person++;
      const k = `${r.rule} · ${r.person_id ? 'person' : 'author, no person'}`;
      byRule[k] = (byRule[k] || 0) + 1;
    } else if (r.outcome === 'hold') { t.held++; why[`held: ${r.reason}`] = (why[`held: ${r.reason}`] || 0) + 1; }
    else { t.unknown++; why[`unknown: ${r.reason}`] = (why[`unknown: ${r.reason}`] || 0) + 1; }
  }
  return { t, byRule, why };
}

export function report(rows, resolver, collab) {
  const sept = rows.filter(inSept);
  for (const [label, set] of [['SEPTEMBER 2026 (cohort sale day, Skopje)', sept], ['ALL HISTORY', rows]]) {
    const c = coverage(set, resolver);
    console.log(bold(`\n── ${label}: ${set.length} sales with no seller ──`));
    printTable([c.t]);
    printTable(Object.entries({ ...c.byRule, ...c.why }).sort((a, b) => b[1] - a[1]).map(([k, n]) => ({ evidence: k, orders: n })));
  }
  const st = rows.filter((r) => r.outcome === 'stamp');
  const per = new Map();
  for (const r of st) {
    const k = r.person_id ? (resolver.person(r.person_id)?.display_name + (resolver.person(r.person_id)?.is_manager ? ' [manager]' : '')) : `(no person) ${r.ext}`;
    const e = per.get(k) || { seller: k, all: 0, sept: 0, self_cancelled: 0 };
    e.all++; if (inSept(r)) e.sept++; if (r.author_cancelled_in_altercpa) e.self_cancelled++;
    per.set(k, e);
  }
  console.log(bold('\nCredited — by seller (self_cancelled = the same person cancelled/trashed the lead in AlterCPA)'));
  printTable([...per.values()].sort((a, b) => b.all - a.all).slice(0, 40));
  const withCanc = st.filter((r) => r.canceller_person);
  const self = withCanc.filter((r) => r.author_cancelled_in_altercpa).length;
  console.log(`  AlterCPA cancel/trash with a named operator: ${withCanc.length} — the document author is that same operator in ${self}` +
    ` (${withCanc.length ? Math.round((100 * self) / withCanc.length) : 0}%), someone else in ${withCanc.length - self}.`);
  const unm = new Map();
  for (const r of st.filter((x) => !x.person_id)) {
    const e = unm.get(r.ext) || { author: r.ext, orders: 0, sept: 0, altercpa_canceller: new Map() };
    e.orders++; if (inSept(r)) e.sept++; if (r.canceller_person) e.altercpa_canceller.set(r.canceller_person, (e.altercpa_canceller.get(r.canceller_person) || 0) + 1);
    unm.set(r.ext, e);
  }
  if (unm.size) {
    console.log(bold('\nAuthors with no person yet (stamped with sold_by_ext; name them in Settings → Teams → back-stamps)'));
    printTable([...unm.values()].sort((a, b) => b.orders - a.orders).map((e) => ({ author: e.author, orders: e.orders, sept: e.sept,
      same_lead_cancelled_in_altercpa_by: [...e.altercpa_canceller].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, n]) => `${k} ×${n}`).join(', ') })));
  }
  const basis = {}; let into = 0;
  for (const r of st) basis[r.sold_at_basis] = (basis[r.sold_at_basis] || 0) + 1;
  for (const r of st) if (r.sold_at_basis === 'cohort_day_kept' && r.evidence_at && skopjeMonth(r.evidence_at) === '2026-09') into++;
  console.log(bold('\nsold_at'));
  printTable([basis]);
  console.log(`  cohort_day_kept = the evidence falls in another month than today's sale day; ${into} of them would have moved INTO September.` +
    ' No stamped order changes its cohort month.');
  const unk = rows.filter((r) => r.outcome !== 'stamp').sort((a, b) => b.value_mkd - a.value_mkd);
  console.log(bold(`\nTop unknown / held (by value, of ${unk.length}; all in the CSV)`));
  printTable(unk.slice(0, 20).map((r) => ({ order: r.display_id, day: r.cohort_day, status: r.status, bucket: r.bucket, ден: fmtMkd(r.value_mkd),
    tracking: r.tracking.slice(0, 22), why: r.reason, altercpa: r.altercpa, canceller: r.canceller_person || '' })));
  const ends = [...collab.typeEnd].filter(([t]) => LEAD_TYPES.has(t)).map(([, v]) => `${v.name} ${fmtSkopje(v.at)}`);
  console.log(`  collabBox export: ${collab.docs} documents; last lead documents: ${ends.join(' · ')}`);
}

// ─── the plan (read-only; exported so a review harness can run it without recording) ──
export async function buildPlan({ dir = DEFAULT_COLLAB_DIR, opts = { phoneRule: true, holdSelfCancelled: false } } = {}) {
  const collab = loadCollab(dir);
  ok(`collabBox evidence: ${collab.docs} documents, ${collab.komitenti} customers with a phone (${collab.ordersPath}, sha ${collab.fileSha.slice(0, 12)}…, ${fmtSkopje(statSync(collab.ordersPath).mtime)})`);
  const all = await sqlRead(candidatesSql());
  const orders = all.filter((o) => o.in_total && !o.test_phone).map((o) => ({ ...o, parcels: typeof o.parcels === 'string' ? JSON.parse(o.parcels) : (o.parcels || []) }));
  ok(`${orders.length} cohort sales without a seller stamp (${all.length - orders.length} further unresolved rows are not cohort sales now — never stamped)`);

  const resolver = makeResolver(await loadPeople());
  const ev = await loadCrmEvidence(orders.map((o) => o.id));
  const hist = new Map(); for (const h of ev.hist) if (!hist.has(h.order_id)) hist.set(h.order_id, h);
  const push = new Map(); for (const p of ev.push) if (p.agent && !push.has(p.order_id)) push.set(p.order_id, p);
  const phonePick = phonePicks(orders, collab);
  const docNums = [...orders.flatMap((o) => [o.tr, ...o.parcels].filter(Boolean)), ...[...phonePick.values()].filter((p) => p.ok).map((p) => p.doc.doc)];
  const holders = await loadHolders(docNums);
  for (const [id, p] of phonePick) {           // rule 4's document must be nobody's parcel yet
    if (p.ok && (holders.get(p.doc.doc)?.size ?? 0) > 0) phonePick.set(id, { ok: false, reason: 'no_parcel_doc_held_elsewhere' });
  }
  // …and no OTHER sale on the phone could own it (same price, no parcel, ±10 days — the
  // duplicate history rows): the document is one sale, never two
  for (const id of await loadPhoneCompetitors([...phonePick].filter(([, p]) => p.ok).map(([id]) => id))) {
    phonePick.set(id, { ok: false, reason: 'no_parcel_doc_fits_two_orders' });
  }
  const rows = orders.map((o) => classify(o, { collab, resolver, hist, push, holders, phonePick, opts }));
  const stamps = rows.filter((r) => r.outcome === 'stamp');
  const lineOf = new Map(stamps.map((r) => [r.order_id, planLine(r.order_id, r.rule, `${r.person_id || '-'}|${r.ext}|${r.via}|${r.sold_at}`, r.doc || '')]));
  return { collab, resolver, orders, rows, stamps, lines: [...lineOf.values()], lineOf };
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'rollback', 'no-phone-rule', 'hold-self-cancelled', 'outside-quiet-window'],
    values: ['run', 'actor', 'chunk', 'collab-dir'],
  });
  const APPLY = !!args.apply;
  mkGuard();
  console.log(bold(`\nSellers from collabBox — ${KEY}`) + (APPLY ? yellow(' — APPLY') : ' — dry run'));
  await assertRemoteIsMk();
  await requireKeepUpdatedAt({ forApply: APPLY });
  const [pre] = await sqlRead(`select to_regclass('public.data_repair_runs') is not null as runs,
      to_regprocedure('public.order_decider_plan(interval)') is not null as plan,
      to_regprocedure('public.cohort_order_bucket(text,numeric,timestamp with time zone,text,text,text,text,integer,integer,timestamp with time zone,boolean)') is not null as bucket`);
  if (!pre.runs || !pre.plan || !pre.bucket) die('data_repair_runs / order_decider_plan / cohort_order_bucket missing — migrations 20260939000300 + 20260940000000 first.');

  if (args.rollback) return rollback(args);

  const opts = { phoneRule: !args['no-phone-rule'], holdSelfCancelled: !!args['hold-self-cancelled'] };
  const options = { phone_rule: opts.phoneRule, hold_self_cancelled: opts.holdSelfCancelled };
  const dir = args['collab-dir'] || DEFAULT_COLLAB_DIR;
  const { collab, resolver, orders, rows, stamps, lines, lineOf } = await buildPlan({ dir, opts });
  report(rows, resolver, collab);
  const byId = new Map(orders.map((o) => [o.id, o]));
  const csv = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, rows.map((r) => ({
    order: r.display_id, outcome: r.outcome, rule: r.rule || '', reason: r.reason || '', seller: r.person_id ? resolver.person(r.person_id)?.display_name : '',
    sold_by_ext: r.ext || '', sold_via: r.via || '', sold_at: r.sold_at ? fmtSkopje(r.sold_at) : '', sold_at_basis: r.sold_at_basis || '',
    cohort_day: r.cohort_day, status: r.status, bucket: r.bucket, value_mkd: r.value_mkd, source: r.source, tracking: r.tracking,
    doc: r.doc || '', doc_type: r.doc_type || '', doc_at: r.doc_at || '', author: r.author || '', altercpa: r.altercpa,
    altercpa_canceller: r.canceller_person || '', author_cancelled_in_altercpa: r.author_cancelled_in_altercpa ? 'yes' : '',
  })));
  ok(`CSV (PII-free, stays in exports/): ${csv}`);

  const sept = rows.filter(inSept);
  const summary = {
    script: 'backfill-sellers-collabbox.mjs', options,
    evidence: { file: collab.ordersPath, sha256: collab.fileSha, documents: collab.docs },
    counts: { candidates: rows.length, stamp: stamps.length, with_person: stamps.filter((r) => r.person_id).length,
      held: rows.filter((r) => r.outcome === 'hold').length, unknown: rows.filter((r) => r.outcome === 'unknown').length },
    september: coverage(sept, resolver), all: coverage(rows, resolver),
    csv: csv.split(/[\\/]/).pop(),
  };

  if (!APPLY) {
    if (!lines.length) { console.log(bold('\nNothing to stamp — no run recorded.\n')); return; }
    const { id, hash } = await recordDryRun({ key: KEY, lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…, ${lines.length} orders)`);
    console.log('Nothing was written to orders. After review, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    const same = `${opts.phoneRule ? '' : ' --no-phone-rule'}${opts.holdSelfCancelled ? ' --hold-self-cancelled' : ''}${args['collab-dir'] ? ` --collab-dir "${dir}"` : ''}`;
    console.log(`  node scripts/backfill-sellers-collabbox.mjs --apply --run ${id}${same}\n`);
    return;
  }

  // apply
  requireQuietWindow({ override: !!args['outside-quiet-window'] });
  await requireNoSegmentRecompute('start the apply');
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines, options });
  const items = stamps.filter((r) => !done.has(r.order_id)).map((r) => ({
    order_id: r.order_id, rule: r.rule, via: r.via, sold_at: r.sold_at, person_id: r.person_id, ext: r.ext,
    status: byId.get(r.order_id).status, expect_tracking: byId.get(r.order_id).tr,
    line: lineOf.get(r.order_id),
    evidence: { doc: r.doc || null, doc_type: r.doc_type || null, doc_at: r.doc_at || null, author: r.author || null,
      sold_at_basis: r.sold_at_basis, evidence_at: r.evidence_at, altercpa: r.altercpa || null, author_cancelled_in_altercpa: r.author_cancelled_in_altercpa },
  }));
  console.log(bold(`\nStamping ${items.length} orders`));
  const stats = await applyChunked({ items, build: (chunk) => buildStampChunkSql({ runId: args.run, rows: chunk }), chunkSize: Number(args.chunk) || MAX_CHUNK });
  const payload = { script: 'backfill-sellers-collabbox.mjs', options, counts: summary.counts, applied_orders: stats.applied,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size,
    outside_quiet_window: !!args['outside-quiet-window'] };
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
  console.log(yellow('  Next: the Agents tab (September "no seller") and node scripts/engine-fixture-mk.mjs\n'));
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
