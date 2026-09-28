#!/usr/bin/env node
/**
 * Repair A — the 18.09 AlterCPA catch-up "paid" orders (plan Phase 2 — run AFTER repair B).
 *
 * WHAT WENT WRONG. After the 24-day AlterCPA outage the 2026-09-18 catch-up (import_scope
 * 'all', insert branch PHASE_TO_STATUS[3] = 'paid') wrote 1.344 orders straight in as
 * `paid` from AlterCPA "approved". AlterCPA never moves this account past Packing — only
 * MEX knows shipped/paid — so none of that "paid" is proven. 1.180 are still paid.
 *
 * POPULATION: source_type 'altercpa', status 'paid', an order_history row to 'paid' by
 * 'System (altercpa…' on Skopje date 2026-09-18, and no later 'paid' row by 'System (mex…'.
 *
 * EVIDENCE per order: MEX register parcels (both accounts) on the same last-8 phone, created
 * in [order −3 d, +60 d]; the order's existing link counts even outside that. Only if there
 * is none by phone: the review's exact name + city match (Cyrillic/Latin fold, ≥ 2 name
 * tokens, ≤ 1 edit for tokens ≥ 5 chars, city prefix). Best parcel: delivered, then
 * returned, then in transit; within that the existing link, then a COD fit, then the
 * nearest date. (Delivered-first is the review's rule — it keeps an order that has a
 * delivered parcel from being demoted by a dead "Shipment created" label it happened to be
 * linked to first; the instruction's link → COD → date order applies inside each class.)
 * A parcel another order holds is taken only under R6; otherwise the order is listed.
 *
 * RULES:
 *   R1 delivered, by phone/link     stays paid; parcel linked ('repair'); paid_at = MEX delivery; paid_basis 'mex'
 *   R4 delivered, by name + city    same, link 'name_city' — only the 7 Mile approved ("Друг телефон (одобри)")
 *   R2 returned                     → returned; returned_at = MEX; paid_at NULL
 *   R3 still with the courier       → shipped; shipped_at = parcel created; paid_at NULL
 *   R5 no parcel anywhere           → cancelled, reason no_parcel_7d, cancelled_at = now(), paid_at NULL;
 *                                     the note names the AlterCPA approver (payload app ?? user) + time.
 *                                     Mile confirmed the list exactly as reviewed: the apply REFUSES
 *                                     unless every R5 is on sheet "Нема пратка (откажи)" of
 *                                     exports/repairs/2026-09-27-altercpa-18-09-paid-pregled.xlsx.
 *   R6 the parcel moves back        (owner decision 2026-09-27 — "a parcel belongs to the order it was
 *                                     shipped FOR") the order's matching parcel (same last-8 phone, COD
 *                                     fits its price, created in [−3 d, +60 d]) is held by ANOTHER order H
 *                                     of the same customer whose paid/returned status the MEX reconcile set
 *                                     by flipping H out of a cancel/trash with THIS parcel (H's own MEX note
 *                                     names it), nobody touched H since, and H is not the parcel's collabBox
 *                                     document, not a 0 ден disposition row (repair B's) and not another
 *                                     catch-up order. Moved when H was created outside the parcel's window
 *                                     OR H's COD does not fit it better; kept (manual) when H is itself a
 *                                     real sale that fits and sits inside the window — genuinely ambiguous.
 *                                     "Real sale" = H was confirmed/shipped/paid before that flip (an
 *                                     AlterCPA-cancelled lead never was); --strict-holders counts every
 *                                     priced H as a real sale. Then: mex_link_parcel(force, 'repair'); the
 *                                     order takes the parcel's status as in R1/R2/R3; H goes back to its
 *                                     cancel ('other' + note) or trash ('not_reachable', 21-day park from
 *                                     when it was trashed), paid/returned/shipped dates and paid_basis cleared.
 *   already_proven  paid_basis 'mex' + its own delivered parcel already linked (e.g. by repair B) — nothing to do
 *   manual          parcel held by another order that R6 may not move / claimed by a sibling order / name+city
 *                   match Mile did not review / 7-day-rule exception (postponed, packed < 2 d, approved < 7 d) / --hold
 *   excluded_payout the order is in agent_payout_items
 *
 *   node scripts/repair-altercpa-catchup-paid.mjs                        # dry run → CSV + run id
 *   node scripts/repair-altercpa-catchup-paid.mjs --expect R1=690,manual=114
 *   node scripts/repair-altercpa-catchup-paid.mjs --apply --run <id> --guards-live [--actor mile@elyon.com] [--chunk 200]
 *   --hold ORD-1,ORD-2      leave these untouched (listed as manual; also blocks moving a parcel off them)
 *   --review <xlsx>         another review workbook (default: the 27.09 one)
 *   --strict-holders        R6: treat every priced holder that fits the parcel inside its window as ambiguous
 *   --without-b             allow --apply although repair B has not been applied (not recommended)
 *
 * --guards-live is your statement that the Phase-1 guards are DEPLOYED: altercpa-sync can
 * no longer write paid/returned/shipped (phase 3 → confirmed), the BEFORE INSERT guard is
 * in the DB, and mex-reconcile is the fixed build. Otherwise a catch-up re-run can undo this.
 *
 * SECOND POPULATION — --population unproven-paid (owner 28.09.2026: "treat everything how you
 * think it's accurate, but do it all"). Exactly the orders checker C7 "paid without MEX proof"
 * FAILs on (the SAME SQL: verify-attribution.mjs c7PopulationSql — status paid, created
 * 01.08.2026 → today, no DELIVERED parcel linked, paid_basis operator_ruling/legacy_import
 * exempt): the catch-up orders repair A left manual, the AlterCPA history imports that came in
 * as paid, and a collabBox import. Same evidence, same R1–R6, same payout exclusion and manual
 * list, with three differences:
 *   · R5 needs no review sheet — the owner approved it on 28.09.2026, so the run REFUSES any R5
 *     unless --owner-approved 2026-09-28 is given (dry run and apply alike; the flag is recorded
 *     in the run's options, so the apply must repeat it).
 *   · The no-parcel exception window is app_settings.no_parcel_rule.days (10 since 28.09), not
 *     7; the cancel reason stays 'no_parcel_7d'.
 *   · A collabBox import is decided by its OWN DocNumber (= its MEX tracking id), never by other
 *     parcels on the phone: delivered → R1, returned → R2, anything else → R3; a DocNumber in
 *     neither MEX register → manual.
 *   · --evidence-guards (opt-in, recorded in the options): a parcel that cannot be this order's is
 *     no evidence — COD 0 (a free replacement; owner ruling 28.09.2026, "not an order") or another
 *     channel's parcel (scripts/lib/cod-price.mjs linkSuspicion: e.g. a NATURA teleshop/social
 *     9100/9102/9108 parcel for an AlterCPA order). Without it the evidence is exactly repair A's.
 * It records under its own ledger key (altercpa-unproven-paid; order_history actor
 * 'System (repair:altercpa-unproven-paid)'), and its apply also checks the bulk-write guards
 * (keep_updated_at, quiet window, no segment recompute / 7-day rule running).
 *   node scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid --owner-approved 2026-09-28 [--evidence-guards] [--hold …]
 *   node scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid --owner-approved 2026-09-28 \
 *        --apply --run <id> --guards-live [--evidence-guards] [--hold …] [--outside-quiet-window]
 *   (the apply must repeat the dry run's --evidence-guards / --hold / --strict-holders: they are in its hash or options)
 *
 * 🛑 Macedonia only (repair-kit guards). Writes only with --apply, in the quiet window.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  ROOT, MK_REF, DAY_MS, NOW, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  q, qTextArray, qUuid, qUuidArray, parseArgs, parseExpect, checkDrift, expectString,
  phone8, toMs, isoOrNull, expectedCodMkd, codFit, fold, nameTokens, nameSimTokens, cityOkFolded, isSyntheticProductName,
  fmtMkd, fmtSkopje, fmtSkopjeDate, skopjeHour, fileStamp, writeCsv, planLine,
  loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects, printTrashFalls,
  loadHistory, loadMexNotes, mexFlipRevert, revertDispositionSet, trashParkNote, parcelWord,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  edgeFunctionInfo, printTable, tally,
  requireKeepUpdatedAt, requireQuietWindow, requireNoSegmentRecompute,
} from './lib/repair-kit.mjs';
import { c7PopulationSql } from './verify-attribution.mjs';
import { linkSuspicion } from './lib/cod-price.mjs';

export const KEY = 'altercpa-catchup-paid';
/** --population unproven-paid: its own ledger key (rollback-repair.mjs handles any key). */
export const UNPROVEN_KEY = 'altercpa-unproven-paid';
export const POPULATIONS = Object.freeze({ catchup: KEY, 'unproven-paid': UNPROVEN_KEY });
/** The owner's approval of the unproven-paid R5 cancels (28.09.2026) — the value --owner-approved must carry. */
export const OWNER_APPROVED = '2026-09-28';
export const REASON = 'no_parcel_7d';
const CATCHUP_DAY = '2026-09-18';
const WINDOW_BEFORE_MS = 3 * DAY_MS;
const WINDOW_AFTER_MS = 60 * DAY_MS;
export const REVIEW_FILE = join(ROOT, 'exports', 'repairs', '2026-09-27-altercpa-18-09-paid-pregled.xlsx');
export const SHEETS = {
  R5: 'Нема пратка (откажи)',
  R4: 'Друг телефон (одобри)',
  R23: 'Вратени и во тек',
  R1: 'Доставени (остануваат)',
};
/**
 * The numbers in Mile's review workbook (2026-09-27, 21:57). They were counted by phone
 * WITHOUT checking whether another order already holds the parcel. Printed for reference.
 */
export const REVIEWED = { total: 1180, R1: 759, R2: 46, R3: 23, R4: 7, R5: 345, manual: 0 };
/**
 * Enforced (±2 %): the classification predicted for the state AFTER repair B is applied,
 * measured 2026-09-27 on the live register (B's plan — incl. its D reverts and status
 * follows — applied in memory). R1 includes 29 orders B2 already makes MEX-proven. R6 = 49
 * parcels moved back from an older order the pre-fix reconcile had flipped. `manual` = 68
 * orders whose parcel is held by another order R6 may not move (mostly: the COD fits that
 * order, not this one) — they stay paid for a human decision. trash_permanent = 48
 * customers whose EXISTING permanent trash comes back because the fake 18.09 "paid" (or a
 * flipped holder's fake paid) was their only release; the repair itself writes no permanent
 * trash. Before B is applied this WILL drift, on purpose.
 */
export const EXPECTED = { total: 1176, R1: 687, R2: 6, R3: 18, R4: 3, R5: 345, R6: 49, manual: 68, trash_permanent: 48 };
/**
 * --population unproven-paid, measured on the live register 2026-09-28 ~07:00 Skopje (after B, A,
 * cod-price and test-phones were applied): 132 = 68 catch-up orders A left manual + 63 AlterCPA
 * history imports + 1 collabBox import. manual = 66 of A's 68 (their parcel is still held by an
 * order R6 may not move; one became R6 at 07:07 when the live reconcile flipped its holder ORD-78553
 * trashed → shipped) + 7 history imports. trash_permanent = 6 customers whose EXISTING
 * permanent trash (5 wrong_person, 1 other) comes back once the fake history-import "paid" goes.
 * With --evidence-guards: 2 R1 whose only parcel is COD 0 / a NATURA social parcel become manual
 * (a name+city match remains, unreviewed), 2 manual whose only parcel is a NATURA teleshop sale
 * become R5.
 */
export const EXPECTED_UNPROVEN = { total: 132, R1: 5, R2: 3, R3: 4, R4: 0, R5: 43, R6: 4, manual: 73, trash_permanent: 6 };
export const EXPECTED_UNPROVEN_GUARDED = { ...EXPECTED_UNPROVEN, R1: 3, R5: 45 };

// ─── loaders (read-only) ────────────────────────────────────────────────────
export async function loadPopulation() {
  return sqlRead(`
    select o.id, o.display_id, o.status::text as status, o.price, o.quantity, o.product_name,
           o.customer_name, o.customer_phone, o.customer_city, o.created_at, o.mex_tracking_id,
           o.packed_at, o.ship_after_date, o.paid_at, o.paid_basis, h.at18,
           l.altercpa_id, l.payload->>'app' as cpa_app, l.payload->>'user' as cpa_user,
           l.payload->>'done' as cpa_done, left(l.payload->>'comment', 400) as cpa_comment
      from public.orders o
      join lateral (
            select min(hh.changed_at) as at18 from public.order_history hh
             where hh.order_id = o.id and hh.to_status = 'paid'
               and hh.changed_by_name like 'System (altercpa%'
               and (hh.changed_at at time zone 'Europe/Skopje')::date = date ${q(CATCHUP_DAY)}) h on h.at18 is not null
      left join lateral (
            select ll.altercpa_id, ll.payload from public.altercpa_leads ll
             where ll.order_id = o.id order by ll.last_seen_at desc nulls last limit 1) l on true
     where o.source_type = 'altercpa' and o.status = 'paid'
       and not exists (select 1 from public.order_history m
                        where m.order_id = o.id and m.to_status = 'paid'
                          and m.changed_by_name like 'System (mex%' and m.changed_at > h.at18)`);
}

/**
 * --population unproven-paid: exactly checker C7's FAIL set (the same SQL — c7PopulationSql),
 * with the columns the classifier reads. `paid_by` / `paid_written_at` = the latest history row
 * to 'paid' (NULL for a history import that came in as paid).
 */
export async function loadUnprovenPaidPopulation() {
  return sqlRead(`
    with c7 as (${c7PopulationSql()})
    select o.id, o.display_id, o.status::text as status, o.price, o.quantity, o.product_name,
           o.customer_name, o.customer_phone, o.customer_city, o.created_at, o.mex_tracking_id,
           o.packed_at, o.ship_after_date, o.paid_at, o.paid_basis,
           o.source_type, o.external_source, o.external_order_id, lp.paid_by, lp.paid_written_at,
           l.altercpa_id, l.payload->>'app' as cpa_app, l.payload->>'user' as cpa_user,
           l.payload->>'done' as cpa_done, left(l.payload->>'comment', 400) as cpa_comment
      from c7 join public.orders o on o.id = c7.id
      left join lateral (
            select hh.changed_by_name as paid_by, hh.changed_at as paid_written_at from public.order_history hh
             where hh.order_id = o.id and hh.to_status = 'paid' order by hh.changed_at desc limit 1) lp on true
      left join lateral (
            select ll.altercpa_id, ll.payload from public.altercpa_leads ll
             where ll.order_id = o.id order by ll.last_seen_at desc nulls last limit 1) l on true
     order by o.display_id`);
}

/** app_settings.no_parcel_rule.days — the no-parcel rule's window (10 since 28.09.2026). */
export async function loadNoParcelDays() {
  const [r] = await sqlRead(`select (value->>'days')::int as days from public.app_settings where key = 'no_parcel_rule'`);
  const d = Number(r?.days);
  return Number.isInteger(d) && d > 0 ? d : 10;
}

/** A collabBox import whose DocNumber (external_order_id) is its MEX tracking id — MEX decides it by that parcel alone. */
export const collabDocOf = (o) => (o.external_source === 'collabbox' && /^\d{3}-[0-9A-Z]+-\d+\/\d{4}$/.test(String(o.external_order_id || ''))
  ? String(o.external_order_id) : null);

const PARCEL_COLS = `tracking_id, account, series, status_id, status_name, cod_mkd, receiver_name, receiver_city,
  phone8, created_at_mex, delivered_at, returned_at, last_update_at, order_id, link_method`;

/** Every register parcel that can be evidence: the date window + anything linked to the population. */
export async function loadParcels(orders) {
  if (!orders.length) return [];
  const ms = orders.map((o) => toMs(o.created_at));
  const from = new Date(Math.min(...ms) - WINDOW_BEFORE_MS).toISOString();
  const to = new Date(Math.max(...ms) + WINDOW_AFTER_MS).toISOString();
  const out = new Map();
  let after = '';
  for (;;) {
    const page = await sqlRead(`select ${PARCEL_COLS} from public.mex_parcels
      where created_at_mex >= ${q(from)}::timestamptz and created_at_mex <= ${q(to)}::timestamptz
        and tracking_id > ${q(after)} order by tracking_id limit 5000`);
    for (const p of page) out.set(p.tracking_id, p);
    if (page.length < 5000) break;
    after = page[page.length - 1].tracking_id;
  }
  const ids = orders.map((o) => o.id);
  const linked = [...orders.map((o) => o.mex_tracking_id), ...orders.map(collabDocOf)].filter(Boolean);
  for (let i = 0; i < Math.max(ids.length, linked.length); i += 1000) {
    const extra = await sqlRead(`select ${PARCEL_COLS} from public.mex_parcels
      where order_id = any(${qUuidArray(ids.slice(i, i + 1000))}) or tracking_id = any(${qTextArray(linked.slice(i, i + 1000))})`);
    for (const p of extra) out.set(p.tracking_id, p);
  }
  return [...out.values()];
}

/** Who holds each tracking id on the orders side (the register can lag behind it). */
export async function loadTrackingHolders() {
  return sqlRead(`select id, display_id, status::text as status, source_type, created_at, mex_tracking_id
    from public.orders where mex_tracking_id is not null`);
}

/**
 * R6 needs the full facts of every order that holds a parcel on one of the population's
 * phones: price/product (real sale?), phone, collabBox document, confirmed_at, plus its
 * history and MEX notes (was its status a MEX flip of a cancel/trash, and via which parcel?).
 */
export async function loadHolderFacts(orders, parcels, holders) {
  const k8 = new Set(orders.map((o) => phone8(o.customer_phone)).filter((k) => k.length === 8));
  const popIds = new Set(orders.map((o) => o.id));
  const onPhones = new Set(parcels.filter((p) => k8.has(p.phone8)).map((p) => p.tracking_id));
  const ids = new Set();
  for (const h of holders) if (onPhones.has(h.mex_tracking_id) && !popIds.has(h.id)) ids.add(h.id);
  for (const p of parcels) if (onPhones.has(p.tracking_id) && p.order_id && !popIds.has(p.order_id)) ids.add(p.order_id);
  const list = [...ids];
  const facts = new Map();
  for (let i = 0; i < list.length; i += 1000) {
    const rows = await sqlRead(`select o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.source_type,
        o.external_source, o.external_order_id, o.created_at, o.confirmed_at, o.mex_tracking_id,
        o.customer_name, o.customer_phone, o.customer_city,
        (select ll.reason from public.altercpa_leads ll where ll.order_id = o.id order by ll.last_seen_at desc nulls last limit 1) as cpa_reason,
        (select ll.phase from public.altercpa_leads ll where ll.order_id = o.id order by ll.last_seen_at desc nulls last limit 1) as cpa_phase
      from public.orders o where o.id = any(${qUuidArray(list.slice(i, i + 1000))})`);
    for (const r of rows) facts.set(r.id, r);
  }
  const [history, notes] = await Promise.all([loadHistory(list), loadMexNotes(list)]);
  return { facts, history, notes };
}

/** For the owner: what the orders that hold a "manual" order's parcel are (presentation only). */
export async function loadHolderDetails(displayIds) {
  const list = [...new Set(displayIds.filter((d) => /^ORD-\d+$/.test(d)))];
  if (!list.length) return new Map();
  const rows = await sqlRead(`select o.display_id, o.status::text as status, o.source_type, o.created_at, o.price,
      exists (select 1 from public.order_history h where h.order_id = o.id
               and h.changed_by_name = 'System (mex:reconciliation)' and h.from_status in ('cancelled', 'trashed')) as flipped_by_mex,
      (select ll.payload->>'phase' from public.altercpa_leads ll where ll.order_id = o.id limit 1) as cpa_phase,
      (select ll.payload->>'reason' from public.altercpa_leads ll where ll.order_id = o.id limit 1) as cpa_reason
    from public.orders o where o.display_id = any(${qTextArray(list)})`);
  return new Map(rows.map((r) => [r.display_id,
    `${r.display_id} ${r.status}/${r.source_type} ${fmtSkopjeDate(r.created_at)} ${fmtMkd(expectedCodMkd(r.price))} ден` +
    `${r.flipped_by_mex ? ' (was cancelled/trashed, flipped by MEX reconcile)' : ''}` +
    `${r.cpa_phase ? ` AlterCPA phase ${r.cpa_phase}${Number(r.cpa_reason) ? ` reason ${r.cpa_reason}` : ''}` : ''}`]));
}

export function loadOperators() {
  try {
    return JSON.parse(readFileSync(join(ROOT, 'scripts', 'data', 'altercpa-operators.json'), 'utf8')).operators || {};
  } catch {
    warn('scripts/data/altercpa-operators.json unreadable — approvers are shown as #id');
    return {};
  }
}

/** The owner-review workbook: which orders Mile saw on which sheet, with which parcel. */
export function loadReview(file = REVIEW_FILE) {
  if (!existsSync(file)) die(`review workbook not found: ${file}`);
  const require = createRequire(import.meta.url);
  const XLSX = require('xlsx');
  const wb = XLSX.readFile(file);
  const out = {};
  for (const [k, name] of Object.entries(SHEETS)) {
    const ws = wb.Sheets[name];
    if (!ws) die(`review workbook has no sheet "${name}"`);
    const map = new Map();
    for (const r of XLSX.utils.sheet_to_json(ws, { defval: '' })) {
      const d = String(r['Нарачка'] || '').trim();
      if (d) map.set(d, String(r['MEX пратка'] || '').trim());
    }
    out[k] = map;
  }
  return out;
}

// ─── classification (pure — no I/O) ─────────────────────────────────────────
const classOf = (p) => (Number(p.status_id) === 2 ? 0 : Number(p.status_id) === 7 ? 1 : 2);
const ruleFor = (p, how) => (Number(p.status_id) === 2 ? (how === 'name_city' ? 'R4' : 'R1') : Number(p.status_id) === 7 ? 'R2' : 'R3');
const TARGET = { R1: 'paid', R4: 'paid', R2: 'returned', R3: 'shipped', R5: 'cancelled' };

export function approverOf(o, operators) {
  const id = Number(o.cpa_app) || Number(o.cpa_user) || 0;
  const doneMs = Number(o.cpa_done) ? Number(o.cpa_done) * 1000 : null;
  return {
    id: id || null,
    name: id ? (operators[String(id)] || `AlterCPA #${id}`) : 'unknown operator',
    at: doneMs,
    night: doneMs != null && (skopjeHour(doneMs) >= 23 || skopjeHour(doneMs) < 6),
  };
}

/**
 * @returns {{ units, csv, lines, counts, changes, reclassified, r5NotReviewed, byRule }}
 */
const EMPTY_REVIEW = Object.freeze({ R5: new Map(), R4: new Map(), R23: new Map(), R1: new Map() });

/** unproven-paid: how this order came to read 'paid' without courier proof (note text). */
export function unprovenOrigin(o) {
  const doc = collabDocOf(o);
  if (doc) return `it was imported from collabBox as paid; MEX decides it by its own DocNumber ${doc}`;
  if (String(o.paid_by || '').startsWith('System (altercpa')) {
    return `the AlterCPA sync wrote "paid" on ${fmtSkopjeDate(o.paid_written_at)} without courier proof (before the money guard)`;
  }
  if (o.external_source === 'altercpa' && !o.paid_by) return 'it was imported as paid by the AlterCPA history import — an AlterCPA approval is not money';
  return `it reads paid (${o.paid_by ? `written by ${o.paid_by}` : 'no paid history row'}) without courier proof`;
}

export function classifyCatchup({ orders, parcels, holders, review, operators = {}, payout = new Set(), hold = new Set(),
  holderFacts = { facts: new Map(), history: [], notes: [] }, strictHolders = false,
  nowMs = Date.now(), runTag = 'dry-run', today = fmtSkopjeDate(Date.now()),
  population = 'catchup', noParcelDays = 7, evidenceGuards = false }) {
  const unproven = population === 'unproven-paid';
  const key = unproven ? UNPROVEN_KEY : KEY;
  if (unproven) review = EMPTY_REVIEW;   // the owner approved this population on 28.09 — no review sheet
  const popWord = unproven ? 'unproven-paid' : 'catch-up';
  /**
   * --evidence-guards (unproven-paid only): a parcel that cannot be this order's is no evidence —
   * COD 0 (a free replacement, owner ruling 28.09.2026: "not an order"), or another channel's
   * parcel (cod-price's linkSuspicion: e.g. a NATURA teleshop/social 9100/9102/9108 parcel for an
   * AlterCPA order — "the series decides the channel"). Returns why, or null.
   */
  const guardOf = (o, p) => {
    if (!evidenceGuards || !unproven) return null;
    if (Number(p.cod_mkd) === 0) return `${p.tracking_id} has COD 0 — a replacement shipment, not a sale (owner ruling 28.09.2026)`;
    const s = linkSuspicion(o, p);
    return s ? `${p.tracking_id}: ${s} — another channel's sale` : null;
  };
  const popIds = new Set(orders.map((o) => o.id));
  const byTracking = new Map(parcels.map((p) => [p.tracking_id, p]));
  const holdersBy = new Map();
  for (const h of holders) (holdersBy.get(h.mex_tracking_id) ?? holdersBy.set(h.mex_tracking_id, []).get(h.mex_tracking_id)).push(h);
  const by8 = new Map();
  for (const p of parcels) if (p.phone8) (by8.get(p.phone8) ?? by8.set(p.phone8, []).get(p.phone8)).push(p);
  const regLinked = new Map(); // order id → parcels the register links to it
  for (const p of parcels) if (p.order_id) (regLinked.get(p.order_id) ?? regLinked.set(p.order_id, []).get(p.order_id)).push(p);
  // name + city scan index (folded once — the scan is large)
  const nameIdx = parcels.map((p) => ({ p, t: toMs(p.created_at_mex), city: fold(p.receiver_city), toks: nameTokens(p.receiver_name) }));

  /** every order (id) that owns a parcel: the register's link and the orders-side tracking id */
  const ownersOf = (p) => {
    const s = new Set((holdersBy.get(p.tracking_id) || []).map((h) => h.id));
    if (p.order_id) s.add(p.order_id);
    return s;
  };

  // 1. evidence pools
  const st = new Map();
  for (const o of orders) {
    const T = toMs(o.created_at);
    const cur = o.mex_tracking_id || null;
    const inWin = (p) => { const t = toMs(p.created_at_mex); return t !== null && t >= T - WINDOW_BEFORE_MS && t <= T + WINDOW_AFTER_MS; };
    const own = [...(cur && byTracking.get(cur) ? [byTracking.get(cur)] : []), ...(regLinked.get(o.id) || [])];
    const doc = collabDocOf(o);
    if (doc) {
      // a collabBox import: its DocNumber IS its parcel — MEX decides by that parcel alone
      const P = byTracking.get(doc) || null;
      const all = P ? [P] : [];
      const free = all.filter((p) => [...ownersOf(p)].every((id) => id === o.id));
      st.set(o.id, { o, cur, how: 'docnumber', doc, docMissing: !P, all, free, own: new Set(own.map((p) => p.tracking_id)) });
      continue;
    }
    const k8 = phone8(o.customer_phone);
    let pool = new Map();
    const excluded = new Map();   // tracking → why (--evidence-guards)
    const take = (p) => { const g = guardOf(o, p); if (g) excluded.set(p.tracking_id, g); else pool.set(p.tracking_id, p); };
    for (const p of (k8.length === 8 ? by8.get(k8) || [] : [])) if (inWin(p)) take(p);
    for (const p of own) take(p);
    let how = 'phone';
    if (!pool.size) {
      const oc = fold(o.customer_city), ot = nameTokens(o.customer_name);
      for (const x of nameIdx) {
        if (x.t === null || x.t < T - WINDOW_BEFORE_MS || x.t > T + WINDOW_AFTER_MS) continue;
        if (!cityOkFolded(oc, x.city)) continue;
        if (nameSimTokens(ot, x.toks) >= 2) take(x.p);
      }
      how = 'name_city';
    }
    const all = [...pool.values()];
    const free = all.filter((p) => [...ownersOf(p)].every((id) => id === o.id));
    st.set(o.id, { o, cur, how, all, free, own: new Set(own.map((p) => p.tracking_id)), excluded });
  }

  // 1b. R6 — may a parcel another order holds move back to the catch-up order it was shipped for?
  const fitScore = (price, cod) => { const f = codFit(price, cod); return f === 'exact' ? 2 : f === 'plus_delivery' ? 1 : 0; };
  const inWindowOf = (createdAt, p) => {
    const t = toMs(p.created_at_mex), c = toMs(createdAt);
    return t !== null && c !== null && t >= c - WINDOW_BEFORE_MS && t <= c + WINDOW_AFTER_MS;
  };
  const r6Check = (o, p) => {
    const oScore = fitScore(o.price, p.cod_mkd);
    if (!oScore) return { ok: false, why: `COD ${fmtMkd(p.cod_mkd)} ден does not fit this order's ${fmtMkd(expectedCodMkd(o.price))} ден` };
    const owners = [...ownersOf(p)].filter((id) => id !== o.id);
    if (owners.length !== 1) return { ok: false, why: `${owners.length} orders hold it` };
    if (popIds.has(owners[0])) return { ok: false, why: `held by another ${popWord} order ${st.get(owners[0])?.o.display_id || ''}`.trim() };
    const H = holderFacts.facts.get(owners[0]);
    if (!H) return { ok: false, why: 'its holder was not loaded' };
    if (H.external_source === 'collabbox' && String(H.external_order_id || '') === p.tracking_id) return { ok: false, H, why: `${H.display_id} is the parcel's collabBox document` };
    if (!(Number(H.price) > 0) || isSyntheticProductName(H.product_name)) return { ok: false, H, why: `${H.display_id} is a 0 ден disposition row (repair B's)` };
    if (phone8(H.customer_phone) !== phone8(o.customer_phone)) return { ok: false, H, why: `${H.display_id} is another customer` };
    if (H.mex_tracking_id !== p.tracking_id) return { ok: false, H, why: `${H.display_id} does not name the parcel` };
    if (payout.has(H.id)) return { ok: false, H, why: `${H.display_id} is in agent_payout_items` };
    if (hold.has(H.display_id)) return { ok: false, H, why: `${H.display_id} held back with --hold` };
    const rv = mexFlipRevert({ order: H, history: holderFacts.history, notes: holderFacts.notes, tracking: p.tracking_id });
    if (!rv.ok) return { ok: false, H, why: `${H.display_id}: ${rv.why}` };
    const hWin = inWindowOf(H.created_at, p);
    const hScore = fitScore(H.price, p.cod_mkd);
    if ((strictHolders || rv.soldBefore) && hScore > 0 && hWin) {
      return { ok: false, H, why: `${H.display_id} is itself a sale that fits the parcel inside its window — genuinely ambiguous` };
    }
    if (hWin && hScore > oScore) return { ok: false, H, why: `${H.display_id}'s price fits the parcel better and the parcel is inside its window` };
    return { ok: true, H, rv, hWin, hScore, oScore };
  };
  for (const s of st.values()) {
    s.moves = new Map();   // tracking → r6Check result, for every parcel of its pool someone else holds
    if (s.how !== 'phone') continue;
    for (const p of s.all) if (!s.free.includes(p)) s.moves.set(p.tracking_id, r6Check(s.o, p));
  }

  // 2. one parcel per order, one order per parcel — best evidence first across all orders
  const pairs = [];
  const keyFor = (s, p, movable) => [
    s.how === 'phone' ? 0 : 1,
    classOf(p),
    p.tracking_id === s.cur || s.own.has(p.tracking_id) ? 0 : 1,
    codFit(s.o.price, p.cod_mkd) ? 0 : 1,
    movable ? 1 : 0,
    Math.abs(toMs(p.created_at_mex) - toMs(s.o.created_at)),
  ];
  for (const s of st.values()) {
    for (const p of s.free) pairs.push({ s, p, key: keyFor(s, p, false) });
    for (const p of s.all) if (s.moves.get(p.tracking_id)?.ok) pairs.push({ s, p, key: keyFor(s, p, true), move: s.moves.get(p.tracking_id) });
  }
  pairs.sort((a, b) => {
    for (let i = 0; i < a.key.length; i++) if (a.key[i] !== b.key[i]) return a.key[i] - b.key[i];
    return String(a.s.o.display_id).localeCompare(String(b.s.o.display_id)) || a.p.tracking_id.localeCompare(b.p.tracking_id);
  });
  const claimed = new Map();
  for (const { s, p, move } of pairs) {
    if (s.pick || claimed.has(p.tracking_id)) continue;
    s.pick = p;
    s.pickMove = move || null;
    claimed.set(p.tracking_id, s.o);
  }

  // 3. rules
  const units = [], csv = [], lines = [];
  const changes = new Map();
  const counts = { total: orders.length };
  const byRuleRows = [];
  const reclassified = [];
  const r5NotReviewed = [];
  const sorted = [...st.values()].sort((a, b) => String(a.o.display_id).localeCompare(String(b.o.display_id)));
  for (const s of sorted) {
    const { o } = s;
    const appr = approverOf(o, operators);
    const reviewSheet = review.R5.has(o.display_id) ? 'R5' : review.R4.has(o.display_id) ? 'R4'
      : review.R23.has(o.display_id) ? 'R2/R3' : review.R1.has(o.display_id) ? 'R1' : '';
    const reviewTracking = review.R5.get(o.display_id) ?? review.R4.get(o.display_id) ?? review.R23.get(o.display_id) ?? review.R1.get(o.display_id) ?? '';
    let rule, why = '', heldByList = [];
    const P = s.pick || null;

    if (hold.has(o.display_id)) { rule = 'manual'; why = 'held back with --hold'; }
    else if (payout.has(o.id)) { rule = 'excluded_payout'; why = 'order is in agent_payout_items'; }
    else if (s.docMissing) { rule = 'manual'; why = `its collabBox DocNumber ${s.doc} is in neither MEX register — MEX cannot decide it`; }
    else if (!s.all.length) {
      rule = 'R5';
      const shipAfter = toMs(o.ship_after_date);
      const sold = Math.max(appr.at ?? 0, toMs(o.created_at) ?? 0);
      const rl = `${noParcelDays}-day rule exception`;
      if (shipAfter !== null && nowMs < shipAfter + noParcelDays * DAY_MS) { rule = 'manual'; why = `${rl}: postponed (ship after ${fmtSkopjeDate(o.ship_after_date)})`; }
      else if (o.packed_at && nowMs - toMs(o.packed_at) < 2 * DAY_MS) { rule = 'manual'; why = `${rl}: packed ${fmtSkopje(o.packed_at)}`; }
      else if (nowMs - sold < noParcelDays * DAY_MS) { rule = 'manual'; why = `${rl}: approved less than ${noParcelDays} days ago`; }
    } else if (!P) {
      rule = 'manual';
      const takenBy = [...s.free, ...s.all.filter((p) => s.moves.get(p.tracking_id)?.ok)]
        .map((p) => claimed.get(p.tracking_id)).filter((x) => x && x.id !== o.id).map((x) => x.display_id);
      const heldBy = s.all.flatMap((p) => [...ownersOf(p)].filter((id) => id !== o.id)
        .map((id) => (holdersBy.get(p.tracking_id) || []).find((h) => h.id === id)?.display_id || (popIds.has(id) ? st.get(id)?.o.display_id : id.slice(0, 8))));
      heldByList = [...new Set([...heldBy, ...takenBy])];
      why = [
        heldBy.length ? `${s.how === 'phone' ? 'phone' : s.how === 'docnumber' ? 'DocNumber' : 'name+city'} parcel(s) ${s.all.map((p) => `${p.tracking_id} (${p.status_name || p.status_id})`).join(', ')} held by ${[...new Set(heldBy)].join(', ')}` : '',
        takenBy.length ? `parcel claimed by sibling order ${[...new Set(takenBy)].join(', ')}` : '',
        [...s.moves.entries()].filter(([, m]) => !m.ok).map(([t, m]) => `not moved (${t}): ${m.why}`).join('; '),
      ].filter(Boolean).join('; ');
    } else if (s.pickMove) {
      rule = 'R6';
    } else {
      rule = ruleFor(P, s.how);
      if (s.how === 'name_city') {
        const sheet = rule === 'R4' ? review.R4 : review.R23;
        if (sheet.get(o.display_id) !== P.tracking_id) {
          why = `name+city match to ${P.tracking_id} that Mile did not review (${rule})`;
          rule = 'manual';
        }
      } else if (rule === 'R1' && o.paid_basis === 'mex' && P.order_id === o.id && P.tracking_id === s.cur) {
        rule = 'already_proven';
        why = 'already MEX-proven (paid_basis mex, its delivered parcel linked)';
      }
    }
    if (rule === 'R5' && !unproven && !review.R5.has(o.display_id)) r5NotReviewed.push(o.display_id);
    if (review.R5.has(o.display_id) && rule !== 'R5') reclassified.push({ order: o.display_id, now: rule, why: why || (P ? `${P.tracking_id} ${P.status_name || ''}` : '') });
    counts[rule] = (counts[rule] || 0) + 1;

    const target = rule === 'R6' ? TARGET[ruleFor(P, 'phone')] : (TARGET[rule] || '');
    const tracking = P && ['R1', 'R2', 'R3', 'R4', 'R6'].includes(rule) ? P.tracking_id : (rule === 'already_proven' ? P.tracking_id : '');
    const fit = P ? codFit(o.price, P.cod_mkd) : false;
    const mv = rule === 'R6' ? s.pickMove : null;
    const csvRow = {
      rule, why, order: o.display_id, created: fmtSkopje(o.created_at), customer: o.customer_name, phone: o.customer_phone,
      city: o.customer_city, product: o.product_name, qty: o.quantity, price_mkd: expectedCodMkd(o.price),
      status_now: o.status, target, match: P ? (s.how === 'phone' ? (s.own.has(P.tracking_id) ? 'existing link' : 'phone') : s.how === 'docnumber' ? 'collabBox DocNumber' : 'name+city') : '',
      tracking: P?.tracking_id || '', account: P?.account || '', series: P?.series || '',
      parcel_status: P ? `${P.status_id} ${P.status_name || ''}`.trim() : '', cod_mkd: P?.cod_mkd ?? '', cod_fit: fit || '',
      parcel_created: fmtSkopje(P?.created_at_mex), delivered_at: fmtSkopje(P?.delivered_at), returned_at: fmtSkopje(P?.returned_at),
      receiver: P && s.how === 'name_city' ? `${P.receiver_name || ''} / ${P.receiver_city || ''}` : '',
      current_link: s.cur || '', switched_from: P && s.cur && s.cur !== P.tracking_id ? s.cur : '',
      approver: appr.name, approved_at: fmtSkopje(appr.at), night: appr.night ? 'yes' : '',
      cpa_comment: String(o.cpa_comment || '').replace(/\r?\n/g, ' | '),
      review_sheet: reviewSheet, review_tracking: reviewTracking,
      reclassified: review.R5.has(o.display_id) && rule !== 'R5' ? 'yes' : '', in_payout: payout.has(o.id) ? 'yes' : '', trash_effect: '',
      holders: heldByList.join(', '), holder_detail: '',
      moved_from: mv ? mv.H.display_id : '', moved_from_status: mv ? mv.H.status : '', moved_from_back_to: mv ? mv.rv.revertTo : '',
      moved_from_detail: mv ? `${mv.H.source_type}${mv.H.cpa_phase ? ` AlterCPA phase ${mv.H.cpa_phase}${Number(mv.H.cpa_reason) ? ` reason ${mv.H.cpa_reason}` : ''}` : ''}, created ${fmtSkopjeDate(mv.H.created_at)}, ${fmtMkd(expectedCodMkd(mv.H.price))} ден, flipped ${mv.rv.flip.from_status}→${mv.rv.flip.to_status} ${fmtSkopjeDate(mv.rv.flip.changed_at)}; parcel ${mv.hWin ? 'inside' : 'outside'} its window, its fit ${['none', '+150', 'exact'][mv.hScore]} vs ${['none', '+150', 'exact'][mv.oScore]}` : '',
      free_alternative: mv ? s.free.map((p) => `${p.tracking_id} (${p.status_name || p.status_id}, COD ${fmtMkd(p.cod_mkd)})`).join(', ') : '',
    };
    if (unproven) {
      csvRow.origin = '';
      csvRow.excluded_evidence = [...(s.excluded?.values() || [])].join('; ');
    }
    csv.push(csvRow);
    byRuleRows.push({ rule, mkd: expectedCodMkd(o.price) });
    lines.push(planLine(o.id, rule, target, tracking));
    if (mv) lines.push(planLine(mv.H.id, 'R6_holder', mv.rv.revertTo, P.tracking_id));
    if (!['R1', 'R2', 'R3', 'R4', 'R5', 'R6'].includes(rule)) continue;

    // ── the plan row
    const set = {};
    const unlink = [];
    let link = null;
    if (P) {
      const switching = s.cur && s.cur !== P.tracking_id;
      if (switching) {
        Object.assign(set, { mex_tracking_id: null, mex_account: null, mex_status_id: null, mex_cod_mkd: null,
          mex_delivered_at: null, mex_returned_at: null, mex_last_update_at: null });
      }
      for (const t of s.own) if (t !== P.tracking_id) unlink.push(t);
      link = { tracking: P.tracking_id, method: rule === 'R4' ? 'name_city' : s.how === 'docnumber' ? 'collabbox_import' : 'repair', force: rule === 'R6', expectOwner: P.order_id || null };
    } else if (unproven && rule === 'R5' && (s.cur || s.own.size)) {
      // --evidence-guards excluded the parcel it named (COD 0 / another channel): the cancel drops that link
      Object.assign(set, { mex_tracking_id: null, mex_account: null, mex_status_id: null, mex_cod_mkd: null,
        mex_delivered_at: null, mex_returned_at: null, mex_last_update_at: null });
      for (const t of s.own) unlink.push(t);
    }
    const head = (unproven
      ? `Repair ${key} (run ${runTag}): ${unprovenOrigin(o)}.`
      : `Repair ${KEY} (run ${runTag}): the AlterCPA sync marked this order paid on 18.09.2026 (the outage catch-up) without courier proof.`) +
      (mv ? ` MEX parcel ${P.tracking_id} had been attached to ${mv.H.display_id} by the pre-fix reconcile on ${fmtSkopjeDate(mv.rv.flip.changed_at)}` +
        ` (which flipped that ${mv.rv.revertTo === 'trashed' ? 'trashed' : 'cancelled'} order to ${mv.rv.flip.to_status}); the parcel was shipped for this order` +
        ` — same customer, COD fits this order's price — so it moves back here (owner decision 2026-09-27).` : '');
    let note;
    const acct = P?.account ? `${P.account} ` : '';
    const eff = rule === 'R6' ? ruleFor(P, 'phone') : rule;
    if (eff === 'R1' || eff === 'R4') {
      const paidAt = isoOrNull(P.delivered_at ?? P.last_update_at ?? P.created_at_mex) ?? NOW;
      Object.assign(set, { paid_at: paidAt, paid_basis: 'mex' });
      note = eff === 'R1'
        ? `${head} MEX ${acct}parcel ${P.tracking_id} was delivered ${fmtSkopje(P.delivered_at ?? P.last_update_at)} (COD ${fmtMkd(P.cod_mkd)} ден) — it stays paid, now MEX-proven; the paid date is the delivery.`
        : `${head} MEX ${acct}parcel ${P.tracking_id} was delivered ${fmtSkopje(P.delivered_at ?? P.last_update_at)} (COD ${fmtMkd(P.cod_mkd)} ден) to "${P.receiver_name || ''}" in ${P.receiver_city || '?'} under a different phone — matched by name + city and kept paid, as Mile approved on 27.09.2026.`;
      if (s.cur && s.cur !== P.tracking_id) note += ` The earlier link to ${s.cur} (${byTracking.get(s.cur)?.status_name || 'not delivered'}) was replaced.`;
    } else if (eff === 'R2') {
      Object.assign(set, { status: 'returned', returned_at: isoOrNull(P.returned_at ?? P.last_update_at) ?? NOW, paid_at: null, paid_basis: null });
      note = `${head} MEX ${acct}parcel ${P.tracking_id} was returned to the sender ${fmtSkopje(P.returned_at ?? P.last_update_at)} — no money was collected, so paid → returned.`;
    } else if (eff === 'R3') {
      Object.assign(set, { status: 'shipped', shipped_at: isoOrNull(P.created_at_mex) ?? NOW, paid_at: null, paid_basis: null });
      note = `${head} MEX ${acct}parcel ${P.tracking_id} is still with the courier (${P.status_name || `status ${P.status_id}`}, created ${fmtSkopje(P.created_at_mex)}) — paid → shipped; MEX settles it.`;
    } else {
      const days = Math.floor((nowMs - (appr.at ?? toMs(o.created_at))) / DAY_MS);
      const who = `${appr.name}${appr.at ? ` on ${fmtSkopje(appr.at)}` : ''}`;
      Object.assign(set, {
        status: 'cancelled', cancellation_reason: REASON, cancelled_at: NOW, paid_at: null, paid_basis: null,
        cancellation_reason_notes: unproven
          ? `No MEX parcel ${days} days after the AlterCPA ${appr.at ? `approval (${who}, Skopje)` : `order date (approver: ${appr.name})`} — unproven-paid repair, owner-approved 28.09.2026`
          : `No MEX parcel ${days} days after the AlterCPA approval (${who}, Skopje) — 18.09 catch-up repair`,
      });
      const cmt = String(o.cpa_comment || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      const excl = [...(s.excluded?.values() || [])];
      note = unproven
        ? `${head} No MEX parcel of its own exists in either MEX account — not by phone (created −3 to +60 days around the order), not by name + city —` +
          ` ${days} days after ${appr.at ? 'approval' : 'the order date'}.` +
          (excl.length ? ` The only parcel(s) on the phone are not this order's: ${excl.join('; ')}.` : '') +
          ` ${appr.at ? `Approved in AlterCPA by ${who} (Skopje)` : `AlterCPA approver: ${appr.name}`}${cmt ? `; their comment: "${cmt}"` : ''}.` +
          ` Cancelled as ${REASON} (the no-parcel rule, ${noParcelDays} days since 28.09.2026 — the reason code keeps its name); approved by the owner on 28.09.2026.`
        : `${head} No MEX parcel exists for it in either MEX account — not by phone, not by name + city — ${days} days after approval.` +
          ` Approved in AlterCPA by ${who} (Skopje)${cmt ? `; their comment: "${cmt}"` : ''}.` +
          ` Cancelled as ${REASON}; the list was reviewed and confirmed by Mile on 27.09.2026.`;
    }
    const row = {
      unit: o.id, order_id: o.id, rule, line: planLine(o.id, rule, target, tracking),
      expect_status: o.status, expect_tracking: s.cur,
      set, link, unlink: unlink.length ? unlink : null,
      history: set.status && set.status !== o.status ? { from: o.status, to: set.status } : null,
      note,
      evidence: {
        key, order: o.display_id, tracking: P?.tracking_id || null, account: P?.account || null,
        parcel_status: P?.status_id ?? null, cod_mkd: P?.cod_mkd ?? null, price_mkd: expectedCodMkd(o.price), cod_fit: fit || null,
        match: P ? s.how : null, switched_from: P && s.cur && s.cur !== P.tracking_id ? s.cur : null,
        approver_id: appr.id, approver: appr.name, approved_at: appr.at ? new Date(appr.at).toISOString() : null,
        altercpa_id: o.altercpa_id || null, review_sheet: reviewSheet || null,
        moved_from: mv ? mv.H.display_id : null,
        excluded_evidence: s.excluded?.size ? [...s.excluded.values()] : undefined,
      },
    };
    const rows = [row];
    if (set.status) changes.set(o.id, { status: set.status });
    if (mv) {
      const { H, rv } = mv;
      const flipDate = fmtSkopjeDate(rv.flip.changed_at);
      const cancelNote = `original reason wiped when MEX parcel ${P.tracking_id} was mis-matched on ${flipDate}; the parcel belongs to ${o.display_id}; restored ${today}`;
      const trashNote = trashParkNote(P.tracking_id, P);
      rows.push({
        unit: o.id, order_id: H.id, rule: 'R6_holder', line: planLine(H.id, 'R6_holder', rv.revertTo, P.tracking_id),
        expect_status: H.status, expect_tracking: H.mex_tracking_id,
        set: revertDispositionSet({ revertTo: rv.revertTo, at: rv.originAt, cancelNote, trashNote }),
        link: null, unlink: null,
        history: { from: H.status, to: rv.revertTo },
        note: `Repair ${key} (run ${runTag}): on ${flipDate} the pre-fix MEX reconcile gave this ${rv.revertTo === 'trashed' ? 'trashed' : 'cancelled'} order` +
          ` parcel ${P.tracking_id} and flipped it to ${rv.flip.to_status}. The parcel was shipped for ${o.display_id} (same customer, the ${unproven ? 'paid-without-proof' : '18.09 catch-up'}` +
          ` order its COD fits) and moves there, so this order goes back to ${rv.revertTo}` +
          (rv.revertTo === 'trashed' ? ` as not_reachable: ${trashNote}.` : '; its original reason was wiped, so it reads "other".'),
        evidence: {
          key, order: H.display_id, tracking: P.tracking_id, role: 'loses_parcel', to_order: o.display_id,
          revert_to: rv.revertTo, flipped_at: rv.flip.changed_at, sold_before_flip: rv.soldBefore,
          parcel_in_its_window: mv.hWin, its_fit: mv.hScore, order_fit: mv.oScore,
        },
      });
      changes.set(H.id, rv.revertTo === 'trashed'
        ? { status: 'trashed', trashed_at: rv.originAt, trash_reason: 'not_reachable' } : { status: 'cancelled' });
    }
    units.push({ unit: o.id, rows });
  }
  const byRule = tally(byRuleRows, (r) => r.rule, (r) => r.mkd);
  return { units, csv, lines, counts, changes, reclassified, r5NotReviewed, byRule };
}

// ─── main ───────────────────────────────────────────────────────────────────
const USAGE = `usage: node scripts/repair-altercpa-catchup-paid.mjs [--expect k=n,...] [--hold ORD-1,...] [--review file.xlsx] [--strict-holders]
       node scripts/repair-altercpa-catchup-paid.mjs --apply --run <id> --guards-live [--actor <email>] [--chunk 200] [--strict-holders] [--without-b]
       node scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid --owner-approved 2026-09-28 [--evidence-guards] [--expect k=n,...] [--hold ORD-1,...] [--strict-holders]
       node scripts/repair-altercpa-catchup-paid.mjs --population unproven-paid --owner-approved 2026-09-28 --apply --run <id> --guards-live [--evidence-guards] [--hold ORD-1,...] [--actor <email>] [--chunk 200] [--outside-quiet-window]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'guards-live', 'without-b', 'strict-holders', 'outside-quiet-window', 'evidence-guards', 'help'],
    values: ['run', 'expect', 'actor', 'chunk', 'hold', 'review', 'population', 'owner-approved'],
  });
  if (args.help) { console.log(USAGE); return; }
  const population = args.population || 'catchup';
  if (!(population in POPULATIONS)) die(`--population must be one of: ${Object.keys(POPULATIONS).join(', ')}`);
  if (population !== 'catchup') return mainUnproven(args);
  if (args['owner-approved'] || args['outside-quiet-window'] || args['evidence-guards']) die('--owner-approved / --outside-quiet-window / --evidence-guards belong to --population unproven-paid.');
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair A — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  if (APPLY && !args['guards-live']) {
    die('--apply needs --guards-live: confirm the Phase-1 guards are DEPLOYED (altercpa-sync never writes paid,\n' +
      '  the BEFORE INSERT guard is in the DB, mex-reconcile is the fixed build) — or a catch-up re-run can undo this.');
  }
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY, needReason: REASON });
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const expected = parseExpect(args.expect, EXPECTED);

  // B first — its B2 links hand parcels to orders of this population.
  const [bRun] = await sqlRead(`select count(*) filter (where applied_at is not null)::int as applied, count(*)::int as runs
    from public.data_repair_runs where key = 'mex-ghost-links'`);
  if (!bRun?.applied) {
    const msg = 'repair B (mex-ghost-links) has not been applied — its parcels still sit on ghost rows, so many orders here read as "held by another order".';
    if (APPLY && !args['without-b']) die(`${msg}\n  Apply B first (or pass --without-b if that is really intended).`);
    warn(`${msg} Run B first; this dry run is for orientation only.`);
  }

  // 1. load
  const review = loadReview(args.review || REVIEW_FILE);
  ok(`review workbook: R5 ${review.R5.size} · R4 ${review.R4.size} · returned/in transit ${review.R23.size} · delivered ${review.R1.size}`);
  const operators = loadOperators();
  const orders = await loadPopulation();
  const [parcels, holders] = await Promise.all([loadParcels(orders), loadTrackingHolders()]);
  const holderFacts = await loadHolderFacts(orders, parcels, holders);
  const payout = await loadPayoutOrderIds([...orders.map((o) => o.id), ...holderFacts.facts.keys()]);
  ok(`${orders.length} catch-up orders still paid · ${parcels.length} register parcels in the evidence window · ${holders.length} orders hold a tracking id`);
  ok(`${holderFacts.facts.size} other orders hold a parcel on these customers' phones (R6 candidates checked against their history)`);

  // 2. classify
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const strictHolders = !!args['strict-holders'];
  const plan = classifyCatchup({ orders, parcels, holders, review, operators, payout, hold, runTag, holderFacts, strictHolders });

  // 3. pre-checks
  const phoneRows = await loadPhoneOrders([...orders.map((o) => o.customer_phone), ...[...holderFacts.facts.values()].map((h) => h.customer_phone)]);
  const trash = stickyTrashEffects(phoneRows, plan.changes);
  const effectOf = new Map();
  for (const f of trash.falls) for (const d of f.orders) effectOf.set(d, f.kind === 'parked' ? `parked (not_reachable) until ${fmtSkopjeDate(f.until)}` : `falls into PERMANENT Trash — held by ${f.by}`);
  for (const row of plan.csv) row.trash_effect = effectOf.get(row.order) || (row.moved_from && effectOf.get(row.moved_from) ? `${row.moved_from}: ${effectOf.get(row.moved_from)}` : '');
  const holderInfo = await loadHolderDetails(plan.csv.flatMap((r) => (r.holders ? r.holders.split(', ') : [])));
  for (const row of plan.csv) {
    if (row.holders) row.holder_detail = row.holders.split(', ').map((d) => holderInfo.get(d) || d).join(' | ');
  }
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  // 4. report
  console.log(bold('\nClassification'));
  printTable(Object.entries(plan.byRule).sort().map(([rule, v]) => ({ rule, orders: v.orders, 'CRM value (ден)': fmtMkd(v.mkd) })));
  const r5 = plan.csv.filter((r) => r.rule === 'R5');
  if (r5.length) {
    console.log(bold('R5 — to cancel, by AlterCPA approver'));
    const byOp = tally(r5, (r) => r.approver, (r) => r.price_mkd);
    const night = tally(r5.filter((r) => r.night), (r) => r.approver);
    printTable(Object.entries(byOp).sort((a, b) => b[1].orders - a[1].orders)
      .map(([op, v]) => ({ approver: op, orders: v.orders, 'ден': fmtMkd(v.mkd), 'at night (23–06)': night[op]?.orders || 0 })));
  }
  const manual = plan.csv.filter((r) => ['manual', 'excluded_payout'].includes(r.rule));
  if (manual.length) {
    console.log(bold(`\nNot touched — for a human (${manual.length}); they stay paid until decided`));
    for (const r of manual.slice(0, 60)) console.log(`  ${r.order.padEnd(11)} ${r.rule.padEnd(15)} ${r.why}`);
    if (manual.length > 60) console.log(`  … ${manual.length - 60} more in the CSV (column why)`);
    const kinds = tally(manual.flatMap((r) => (r.holder_detail ? r.holder_detail.split(' | ') : [])), (d) => {
      const m = d.match(/ (\w+)\/(\w+) /);
      return `${m ? `${m[1]}/${m[2]}` : '?'}${d.includes('flipped by MEX') ? ', flipped by the pre-fix MEX reconcile' : ''}${/AlterCPA phase 4/.test(d) ? ', AlterCPA-cancelled' : ''}`;
    });
    console.log('  the orders holding their parcels:');
    printTable(Object.entries(kinds).sort((a, b) => b[1].orders - a[1].orders).map(([holder, v]) => ({ holder, orders: v.orders })));
  }
  if (plan.reclassified.length) {
    console.log(bold(`\nOn the reviewed cancel list but NOT cancelled now (${plan.reclassified.length}) — a parcel turned up or another rule applies`));
    for (const r of plan.reclassified) console.log(`  ${r.order.padEnd(11)} → ${r.now}  ${r.why}`);
  }
  const switched = plan.csv.filter((r) => r.switched_from);
  if (switched.length) {
    console.log(bold(`\nLink replaced by a better parcel (${switched.length})`));
    for (const r of switched) console.log(`  ${r.order.padEnd(11)} ${r.switched_from} → ${r.tracking} (${r.parcel_status})`);
  }
  const moved = plan.csv.filter((r) => r.rule === 'R6');
  if (moved.length) {
    console.log(bold(`\nR6 — parcel moved back to the catch-up order it was shipped for (${moved.length})${strictHolders ? ' [--strict-holders]' : ''}`));
    printTable(Object.entries(tally(moved, (r) => `order paid → ${r.target} · holder ${r.moved_from_status} → ${r.moved_from_back_to}`, (r) => r.price_mkd))
      .map(([move, v]) => ({ move, orders: v.orders, 'ден': fmtMkd(v.mkd) })));
  }
  console.log(bold('\nPre-checks'));
  console.log(`  orders in agent_payout_items: ${plan.counts.excluded_payout || 0}`);
  console.log(`  would set status 'confirmed': 0`);
  const trashCount = printTrashFalls(trash, 'customers who fall back into sticky Trash (their only post-trash "paid" goes, or a holder is re-trashed)');
  const exceptions = manual.filter((r) => r.why.startsWith('7-day rule exception'));
  console.log(`  7-day rule exceptions (not cancelled): ${exceptions.length}`);
  console.log(`  R5 not on the reviewed cancel list: ${plan.r5NotReviewed.length}`);

  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (plan.r5NotReviewed.length) {
    die(`${plan.r5NotReviewed.length} order(s) would be cancelled that are NOT on "${SHEETS.R5}" — Mile approved that list exactly:\n` +
      `  ${plan.r5NotReviewed.join(', ')}\n` +
      '  Get them reviewed, or keep them out with --hold. Nothing recorded, nothing written.');
  }

  // 5. dry run → drift check → ledger row
  if (!APPLY) {
    const counts = {
      total: plan.counts.total,
      R1: (plan.counts.R1 || 0) + (plan.counts.already_proven || 0),
      R2: plan.counts.R2 || 0, R3: plan.counts.R3 || 0, R4: plan.counts.R4 || 0, R5: plan.counts.R5 || 0,
      R6: plan.counts.R6 || 0,
      manual: (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0),
      trash_permanent: trashCount.permanent,
    };
    const drift = checkDrift(counts, expected);
    console.log(bold('\nExpected (predicted after repair B) vs actual — Mile\'s review numbers for reference'));
    printTable(drift.rows.map((r) => ({ bucket: r.bucket, 'review 27.09': REVIEWED[r.bucket] ?? '', expected: r.expected, actual: r.actual, tolerance: r.tolerance, check: r.check })));
    if (!drift.pass) {
      die('Counts drifted more than ±2 % from the expected ones — NO run recorded.\n' +
        (bRun?.applied ? '' : '  Repair B is not applied yet: apply it first, then dry-run this again.\n') +
        '  Read the CSV (rule, why, holder_detail); if the difference is understood, re-run with\n' +
        `  --expect ${expectString(counts, Object.keys(expected))}`);
    }
    const summary = {
      script: 'repair-altercpa-catchup-paid.mjs', expected, counts: plan.counts,
      mkd_by_rule: Object.fromEntries(Object.entries(plan.byRule).map(([k, v]) => [k, v.mkd])),
      reclassified_from_review: plan.reclassified, switched_links: switched.map((r) => r.order),
      moved_back: moved.map((r) => ({ order: r.order, from: r.moved_from, holder_back_to: r.moved_from_back_to })),
      manual: manual.map((r) => ({ order: r.order, rule: r.rule, why: r.why })),
      options: { strict_holders: strictHolders },
      trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked,
      repair_b_applied: !!bRun?.applied, csv: csvPath.split(/[\\/]/).pop(),
    };
    const { id, hash } = await recordDryRun({ key: KEY, lines: plan.lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)`);
    console.log('Nothing was written to orders. After review, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-altercpa-catchup-paid.mjs --apply --run ${id} --guards-live\n`);
    return;
  }

  // 6. apply
  const fns = await edgeFunctionInfo(['altercpa-sync', 'mex-reconcile']);
  console.log(`  altercpa-sync: ${fns['altercpa-sync']} · mex-reconcile: ${fns['mex-reconcile']} — you confirmed (--guards-live) these carry the Phase-1 guards.`);
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: plan.lines, options: { strict_holders: strictHolders } });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  console.log(bold(`\nApplying ${units.length} orders`));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap, chunkSize: args.chunk });
  const payload = {
    script: 'repair-altercpa-catchup-paid.mjs', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size,
  };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger.\n` +
      '  Fix the cause, then re-run the same --apply command: it resumes after the committed chunks.');
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);

  // 7. verify
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.orders where id = any(${qUuidArray(orders.map((o) => o.id))}) and status = 'paid')::int as still_paid,
      (select count(*) from public.orders where id = any(${qUuidArray(orders.map((o) => o.id))}) and status = 'paid'
         and paid_basis is distinct from 'mex')::int as paid_without_mex_basis,
      (select count(*) from public.orders where id = any(${qUuidArray(orders.map((o) => o.id))}) and status = 'cancelled'
         and cancellation_reason = ${q(REASON)})::int as cancelled_no_parcel,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and o.status = 'confirmed')::int as now_confirmed,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null
        group by 1 having count(*) > 1) d)::int as trackings_on_two_orders`);
  console.log(bold('\nVerification'));
  printTable([v]);
  const paidLeft = (plan.counts.R1 || 0) + (plan.counts.R4 || 0) + (plan.counts.already_proven || 0) + (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0);
  console.log(`  still paid: ${v.still_paid} (expected ≈ ${paidLeft}: R1 + R4 + already proven + manual/excluded)`);
  console.log(`  paid without paid_basis 'mex': ${v.paid_without_mex_basis} (expected ≈ manual + excluded = ${(plan.counts.manual || 0) + (plan.counts.excluded_payout || 0)})`);
  if (v.now_confirmed) warn('some repaired orders sit in confirmed — investigate now.');
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs, node scripts/check-segment-counts.mjs, then report C.\n'));
}

/** --population unproven-paid: checker C7's set, the same rules, R5 on the owner's 28.09 approval. */
async function mainUnproven(args) {
  const key = UNPROVEN_KEY;
  const popFlags = `--population unproven-paid --owner-approved ${OWNER_APPROVED}`;
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair A2 — ${key} (checker C7: paid without MEX proof) — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (args.review || args['without-b']) die('--review / --without-b belong to the catch-up population.');
  const ownerApproved = args['owner-approved'] ?? null;
  if (ownerApproved !== null && ownerApproved !== OWNER_APPROVED) {
    die(`--owner-approved must be ${OWNER_APPROVED} (the owner's approval of 28.09.2026), got "${ownerApproved}".`);
  }
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  if (APPLY && !args['guards-live']) {
    die('--apply needs --guards-live: confirm the Phase-1 guards are DEPLOYED (altercpa-sync never writes paid,\n' +
      '  the BEFORE INSERT guard is in the DB, mex-reconcile is the fixed build).');
  }
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY, needReason: REASON });
  await requireKeepUpdatedAt({ forApply: APPLY });
  if (APPLY) {
    requireQuietWindow({ override: !!args['outside-quiet-window'] });
    await requireNoSegmentRecompute('start the apply');
  }
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const expected = parseExpect(args.expect, args['evidence-guards'] ? EXPECTED_UNPROVEN_GUARDED : EXPECTED_UNPROVEN);

  // B and A first — their moves decide who holds which parcel here.
  const [prev] = await sqlRead(`select
      count(*) filter (where key = 'mex-ghost-links' and applied_at is not null)::int as b,
      count(*) filter (where key = ${q(KEY)} and applied_at is not null)::int as a
    from public.data_repair_runs`);
  if (!prev?.b || !prev?.a) {
    const msg = `repair ${!prev?.b ? 'B (mex-ghost-links)' : ''}${!prev?.b && !prev?.a ? ' and ' : ''}${!prev?.a ? `A (${KEY})` : ''} has not been applied`;
    if (APPLY) die(`${msg} — apply it first.`);
    warn(`${msg}; this dry run is for orientation only.`);
  }

  // 1. load
  const noParcelDays = await loadNoParcelDays();
  const operators = loadOperators();
  const orders = await loadUnprovenPaidPopulation();
  const [parcels, holders] = await Promise.all([loadParcels(orders), loadTrackingHolders()]);
  const holderFacts = await loadHolderFacts(orders, parcels, holders);
  const payout = await loadPayoutOrderIds([...orders.map((o) => o.id), ...holderFacts.facts.keys()]);
  const origin = (o) => (collabDocOf(o) ? 'collabBox import' : String(o.paid_by || '').startsWith('System (altercpa') ? 'AlterCPA sync wrote paid'
    : o.external_source === 'altercpa' ? 'AlterCPA history import' : `other (${o.source_type}/${o.external_source || '-'})`);
  ok(`${orders.length} paid orders without MEX proof (checker C7's set) — ${Object.entries(tally(orders, origin)).map(([k, v]) => `${k} ${v.orders}`).join(' · ')}`);
  ok(`${parcels.length} register parcels in the evidence window · ${holders.length} orders hold a tracking id · no-parcel rule: ${noParcelDays} days`);
  ok(`${holderFacts.facts.size} other orders hold a parcel on these customers' phones (R6 candidates checked against their history)`);

  // 2. classify
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const strictHolders = !!args['strict-holders'];
  const evidenceGuards = !!args['evidence-guards'];
  const plan = classifyCatchup({ orders, parcels, holders, review: EMPTY_REVIEW, operators, payout, hold, runTag, holderFacts, strictHolders,
    population: 'unproven-paid', noParcelDays, evidenceGuards });
  const originOf = new Map(orders.map((o) => [o.display_id, origin(o)]));
  for (const row of plan.csv) row.origin = originOf.get(row.order) || '';

  // 3. pre-checks
  const phoneRows = await loadPhoneOrders([...orders.map((o) => o.customer_phone), ...[...holderFacts.facts.values()].map((h) => h.customer_phone)]);
  const trash = stickyTrashEffects(phoneRows, plan.changes);
  const effectOf = new Map();
  for (const f of trash.falls) for (const d of f.orders) effectOf.set(d, f.kind === 'parked' ? `parked (not_reachable) until ${fmtSkopjeDate(f.until)}` : `falls into PERMANENT Trash — held by ${f.by}`);
  for (const row of plan.csv) row.trash_effect = effectOf.get(row.order) || (row.moved_from && effectOf.get(row.moved_from) ? `${row.moved_from}: ${effectOf.get(row.moved_from)}` : '');
  const holderInfo = await loadHolderDetails(plan.csv.flatMap((r) => (r.holders ? r.holders.split(', ') : [])));
  for (const row of plan.csv) {
    if (row.holders) row.holder_detail = row.holders.split(', ').map((d) => holderInfo.get(d) || d).join(' | ');
  }
  if (plan.units.some((u) => u.rows.some((r) => r.set?.status === 'confirmed'))) die('a row would be set to confirmed — refusing.');

  // 4. report
  console.log(bold('\nClassification'));
  printTable(Object.entries(plan.byRule).sort().map(([rule, v]) => ({ rule, orders: v.orders, 'CRM value (ден)': fmtMkd(v.mkd) })));
  console.log(bold('By how the order came to read paid'));
  printTable(Object.entries(tally(plan.csv, (r) => `${r.origin} → ${r.rule}`, (r) => r.price_mkd)).sort()
    .map(([k, v]) => ({ 'origin → rule': k, orders: v.orders, 'ден': fmtMkd(v.mkd) })));
  const r5 = plan.csv.filter((r) => r.rule === 'R5');
  if (r5.length) {
    console.log(bold(`R5 — to cancel (${REASON}), by AlterCPA approver`));
    const byOp = tally(r5, (r) => r.approver, (r) => r.price_mkd);
    printTable(Object.entries(byOp).sort((a, b) => b[1].orders - a[1].orders).map(([op, v]) => ({ approver: op, orders: v.orders, 'ден': fmtMkd(v.mkd) })));
  }
  const manual = plan.csv.filter((r) => ['manual', 'excluded_payout'].includes(r.rule));
  if (manual.length) {
    console.log(bold(`\nNot touched — for a human (${manual.length}); they stay paid until decided`));
    for (const r of manual) console.log(`  ${r.order.padEnd(11)} ${r.rule.padEnd(15)} ${r.why}`);
  }
  const switched = plan.csv.filter((r) => r.switched_from);
  if (switched.length) {
    console.log(bold(`\nLink replaced by a better parcel (${switched.length})`));
    for (const r of switched) console.log(`  ${r.order.padEnd(11)} ${r.switched_from} → ${r.tracking} (${r.parcel_status})`);
  }
  const moved = plan.csv.filter((r) => r.rule === 'R6');
  if (moved.length) {
    console.log(bold(`\nR6 — parcel moved back to the order it was shipped for (${moved.length})${strictHolders ? ' [--strict-holders]' : ''}`));
    printTable(Object.entries(tally(moved, (r) => `order paid → ${r.target} · holder ${r.moved_from_status} → ${r.moved_from_back_to}`, (r) => r.price_mkd))
      .map(([move, v]) => ({ move, orders: v.orders, 'ден': fmtMkd(v.mkd) })));
  }
  const guarded = plan.csv.filter((r) => r.excluded_evidence);
  if (guarded.length) {
    console.log(bold(`\nEvidence excluded by --evidence-guards (${guarded.length} orders)`));
    for (const r of guarded) console.log(`  ${r.order.padEnd(11)} → ${r.rule.padEnd(6)} ${r.excluded_evidence}`);
  }
  const acted = plan.csv.filter((r) => ['R1', 'R2', 'R3', 'R4', 'R6'].includes(r.rule));
  if (acted.length) {
    console.log(bold(`\nParcel found (${acted.length})`));
    for (const r of acted) console.log(`  ${r.order.padEnd(11)} ${r.rule.padEnd(3)} → ${String(r.target).padEnd(8)} ${r.tracking} ${r.parcel_status} COD ${r.cod_mkd} vs ${r.price_mkd} ден (${r.match}${r.moved_from ? `, from ${r.moved_from}` : ''})`);
  }
  console.log(bold('\nPre-checks'));
  console.log(`  orders in agent_payout_items: ${plan.counts.excluded_payout || 0}`);
  console.log(`  would set status 'confirmed': 0`);
  const trashCount = printTrashFalls(trash, 'customers who fall back into sticky Trash (their only post-trash "paid" goes, or a holder is re-trashed)');
  console.log(`  ${noParcelDays}-day rule exceptions (not cancelled): ${manual.filter((r) => /^\d+-day rule exception/.test(r.why)).length}`);

  const csvPath = writeCsv(`${key}-${APPLY ? 'apply-' : ''}${fileStamp()}.csv`, plan.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);

  if (r5.length && ownerApproved !== OWNER_APPROVED) {
    die(`${r5.length} order(s) would be cancelled ${REASON} (no MEX parcel anywhere). The owner approved that on 28.09.2026 —\n` +
      `  re-run with --owner-approved ${OWNER_APPROVED} to record it (or keep them out with --hold). Nothing recorded, nothing written.`);
  }
  const options = { strict_holders: strictHolders, population: 'unproven-paid', owner_approved: ownerApproved, evidence_guards: evidenceGuards };

  // 5. dry run → drift check → ledger row
  if (!APPLY) {
    const counts = {
      total: plan.counts.total,
      R1: (plan.counts.R1 || 0) + (plan.counts.already_proven || 0),
      R2: plan.counts.R2 || 0, R3: plan.counts.R3 || 0, R4: plan.counts.R4 || 0, R5: plan.counts.R5 || 0,
      R6: plan.counts.R6 || 0,
      manual: (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0),
      trash_permanent: trashCount.permanent,
    };
    const drift = checkDrift(counts, expected);
    console.log(bold('\nExpected vs actual'));
    printTable(drift.rows);
    if (!drift.pass) {
      die('Counts drifted more than ±2 % from the expected ones — NO run recorded.\n' +
        '  Read the CSV (rule, why, holder_detail); if the difference is understood, re-run with\n' +
        `  --expect ${expectString(counts, Object.keys(expected))}`);
    }
    const summary = {
      script: 'repair-altercpa-catchup-paid.mjs', population: 'unproven-paid', source: 'verify-attribution C7 (c7PopulationSql)',
      expected, counts: plan.counts, no_parcel_days: noParcelDays,
      by_origin: Object.fromEntries(Object.entries(tally(plan.csv, (r) => `${r.origin} → ${r.rule}`)).map(([k, v]) => [k, v.orders])),
      mkd_by_rule: Object.fromEntries(Object.entries(plan.byRule).map(([k, v]) => [k, v.mkd])),
      switched_links: switched.map((r) => r.order),
      moved_back: moved.map((r) => ({ order: r.order, from: r.moved_from, holder_back_to: r.moved_from_back_to })),
      manual: manual.map((r) => ({ order: r.order, rule: r.rule, why: r.why })),
      options,
      trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked,
      csv: csvPath.split(/[\\/]/).pop(),
    };
    const { id, hash } = await recordDryRun({ key, lines: plan.lines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)`);
    console.log('Nothing was written to orders. After review, in the quiet window (after 20:55 Skopje):');
    console.log('  node scripts/assert-mk-target.mjs');
    console.log(`  node scripts/repair-altercpa-catchup-paid.mjs ${popFlags} --apply --run ${id} --guards-live` +
      `${strictHolders ? ' --strict-holders' : ''}${evidenceGuards ? ' --evidence-guards' : ''}${hold.size ? ` --hold ${[...hold].join(',')}` : ''}\n`);
    return;
  }

  // 6. apply
  const fns = await edgeFunctionInfo(['altercpa-sync', 'mex-reconcile']);
  console.log(`  altercpa-sync: ${fns['altercpa-sync']} · mex-reconcile: ${fns['mex-reconcile']} — you confirmed (--guards-live) these carry the Phase-1 guards.`);
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key, runId: args.run, lines: plan.lines, options });
  const units = plan.units.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  console.log(bold(`\nApplying ${units.length} orders`));
  const stats = await applyUnits({ key, runId: args.run, units, typeMap, chunkSize: args.chunk });
  const payload = {
    script: 'repair-altercpa-catchup-paid.mjs', population: 'unproven-paid', counts: plan.counts, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size,
    owner_approved: ownerApproved, outside_quiet_window: !!args['outside-quiet-window'],
  };
  if (stats.failed) {
    await auditPartial({ key, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger.\n` +
      '  Fix the cause, then re-run the same --apply command: it resumes after the committed chunks.');
  }
  await finalizeRun({ key, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);

  // 7. verify
  const ids = qUuidArray(orders.map((o) => o.id));
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.orders where id = any(${ids}) and status = 'paid')::int as still_paid,
      (select count(*) from public.orders where id = any(${ids}) and status = 'paid' and paid_basis is distinct from 'mex')::int as paid_without_mex_basis,
      (select count(*) from public.orders where id = any(${ids}) and status = 'cancelled' and cancellation_reason = ${q(REASON)})::int as cancelled_no_parcel,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and o.status = 'confirmed')::int as now_confirmed,
      (select count(*) from (${c7PopulationSql()}) c7)::int as c7_now`);
  console.log(bold('\nVerification'));
  printTable([v]);
  const paidLeft = (plan.counts.R1 || 0) + (plan.counts.R4 || 0) + (plan.counts.already_proven || 0) + (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0);
  console.log(`  still paid: ${v.still_paid} (expected ≈ ${paidLeft}: R1 + R4 + manual/excluded)`);
  console.log(`  checker C7 now: ${v.c7_now} (expected ≈ manual + excluded = ${(plan.counts.manual || 0) + (plan.counts.excluded_payout || 0)})`);
  if (v.now_confirmed) warn('some repaired orders sit in confirmed — investigate now.');
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs, node scripts/verify-attribution.mjs.\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
