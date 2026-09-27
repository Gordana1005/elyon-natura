#!/usr/bin/env node
/**
 * Repair B — take MEX parcels back off the 0 ден "ghost" rows (plan Phase 2 — run FIRST).
 *
 * WHAT WENT WRONG. When an agent logs a "no" on a prediction-list call, /calls writes a
 * 0 ден cancelled/trashed disposition row ("No prior product on file", no items). The old
 * mex-reconcile single-candidate fallback (index.ts:215-229, fixed in Phase 1) attached
 * unlinked MEX parcels to such rows by phone and flipped them to paid/returned, wiping the
 * agent's reason. Measured 2026-09-27: 178 rows (the plan's ≈182 came from a phone match
 * against the MEX registers; this script uses the history definition below).
 *
 * POPULATION: mex_tracking_id set, status paid/returned/shipped, price 0 or a synthetic
 * product name (isSyntheticProductName), and an order_history row by
 * 'System (mex:reconciliation)' whose from_status was cancelled/trashed.
 *
 * FOR EACH GHOST G (parcel T):
 *   G → back to that history row's from_status, dated G.created_at (the disposition time);
 *       paid_at/returned_at/shipped_at, the tracking id, every mex_* fact and paid_basis
 *       cleared. The reason was wiped by the mis-attach:
 *         cancelled → 'other' + note "original reason wiped when MEX parcel T was
 *                     mis-attached on <date>; restored <today>"
 *         trashed   → 'not_reachable' (owner decision 2026-09-27: the 21-day PARKED class,
 *                     never the permanent 'other' — the customer demonstrably bought through
 *                     another channel), trashed_at = G.created_at, so most parks have
 *                     already run out.
 *   B1  another (real) order already holds T      → unlink G only (the register is pointed
 *                                                    at that holder if it pointed at G); the
 *                                                    holder's status follows the parcel
 *                                                    (MEX decides) unless
 *                                                    --holders-keep-status.
 *   B2  exactly one real order R fits T            → mex_link_parcel(T, R, 'repair', force);
 *       (price > 0, real product, not duplicated,     R takes the MEX status: delivered → paid
 *        same last-8 phone, created in [T −75 d,      (paid_at = delivery, paid_basis 'mex'),
 *        T +3 d], COD = round(price×61,5) ±3 or        returned → returned (paid_at NULL,
 *        +150 ±3, no parcel of its own)                returned_at = MEX), else → shipped
 *                                                    (shipped_at = parcel created); R's
 *                                                    cancel/trash reasons cleared.
 *   B3  no real order fits                         → T stays unlinked (a MEX-only sale).
 *   manual (listed, never touched): several real orders fit / a real order fits two ghosts'
 *       parcels / T sits on several orders / the register points elsewhere / R is in `take`
 *       / G is not an agent disposition row at all (source_type ≠ manual or it has
 *       order_items — a real product order that merely has price 0; its parcel may be its
 *       own) / T is not in the register / --hold.
 *   excluded_payout: any order of the unit sits in agent_payout_items.
 *
 * DOUBLE-HELD TRACKING IDS WITHOUT A GHOST (the backfill's remaining conflicts) — rule D,
 * decided by the coordinator 2026-09-27: when exactly ONE holder is the collabBox import
 * whose DocNumber is the tracking id (external_source 'collabbox' AND external_order_id =
 * tracking id), that holder is the true owner:
 *   D        mex_link_parcel(T, C, 'collabbox_import', force) — the other holder X loses the
 *            tracking id and its mex_* facts (the linker clears them). C's status follows
 *            the parcel (MEX decides, owner decision 2026-09-27).
 *   D_revert X's paid/returned status was set by the MEX reconcile flipping it out of a
 *            cancel/trash via THIS parcel (its own MEX note names T) and nobody changed it
 *            since → X goes back to that cancel/trash, same restore as a ghost (cancel →
 *            'other', trash → 'not_reachable'), dated when it originally became so.
 *   D_other  X's status came from somewhere else → left as it is, listed for a decision.
 *   D_manual no DocNumber holder, or more than one → listed, untouched.
 *
 *   node scripts/repair-mex-ghost-links.mjs                       # dry run → CSV + run id
 *   node scripts/repair-mex-ghost-links.mjs --expect total=178,B2=68
 *   node scripts/repair-mex-ghost-links.mjs --apply --run <id> --guards-live [--actor mile@elyon.com] [--chunk 200]
 *   --hold ORD-1,ORD-2      leave these units untouched (listed as manual)
 *   --holders-keep-status   B1 holders keep their status (only the D owners follow the parcel)
 *
 * --guards-live is your statement that the Phase-1 mex-reconcile (real sales only as
 * candidates, no fallback onto 0 ден rows) is DEPLOYED. With the old function live, its
 * next run can hang a B3 parcel straight back onto the ghost this script just restored.
 *
 * 🛑 Macedonia only (repair-kit guards). Writes happen only with --apply, in the quiet
 * window (after 20:55 Skopje), after `node scripts/assert-mk-target.mjs`.
 */
import { pathToFileURL } from 'node:url';
import {
  MK_REF, DAY_MS, NOW, bold, green, yellow, die, warn, ok,
  mkGuard, sqlRead, assertRemoteIsMk, requireRepairSchema, loadOrderColumnTypes,
  q, qTextArray, qUuid, qUuidArray, parseArgs, parseExpect, checkDrift, expectString,
  phone8, toMs, isoOrNull, expectedCodMkd, codFit, isSyntheticProductName,
  fmtMkd, fmtSkopje, fmtSkopjeDate, fileStamp, writeCsv, planLine,
  loadPayoutOrderIds, loadPhoneOrders, stickyTrashEffects, printTrashFalls,
  loadHistory, loadMexNotes, mexFlipRevert, mexTargetFor, mexStatusSet, revertDispositionSet, trashParkNote, parcelWord,
  resolveActor, recordDryRun, verifyRunForApply, applyUnits, finalizeRun, auditPartial,
  edgeFunctionInfo, printTable, tally,
} from './lib/repair-kit.mjs';

export { loadMexNotes };

export const KEY = 'mex-ghost-links';
const RECONCILE_ACTOR = 'System (mex:reconciliation)';
/**
 * Live check 2026-09-27: 178 ghosts. The split was measured by running classifyGhosts on
 * the live orders against both MEX registers pulled the same day (the plan's 22/73/82 used
 * a looser phone-only match). manual = 4 real price-0 product orders + 6 ambiguous.
 * D / D_manual = double-held tracking ids with no ghost among the holders (after the
 * register backfill of 2026-09-27: 20 with one collabBox DocNumber holder, 3 without).
 * D_revert / D_owner_follow / B1_holder_follow = rows changed by the 2026-09-27 owner
 * decisions; trash_permanent = customers the repair puts into PERMANENT Trash (restored
 * trashes are parked not_reachable, so it must stay 0).
 */
export const EXPECTED = { total: 178, B1: 24, B2: 67, B3: 77, manual: 10, D: 20, D_manual: 3, D_revert: 10, D_owner_follow: 5, B1_holder_follow: 14, trash_permanent: 0 };
const COLLABBOX = 'collabbox';

// ─── loaders (read-only) ────────────────────────────────────────────────────
export async function loadGhosts() {
  const rows = await sqlRead(`
    select o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.source_type,
           o.customer_name, o.customer_phone, o.customer_city, o.created_at, o.mex_tracking_id,
           o.prediction_list_name, o.assigned_agent_name,
           (select count(*) from public.order_items i where i.order_id = o.id)::int as item_count,
           h.from_status::text as orig_status, h.to_status::text as flipped_to, h.changed_at as flipped_at
      from public.orders o
      join lateral (
            select hh.from_status, hh.to_status, hh.changed_at
              from public.order_history hh
             where hh.order_id = o.id and hh.changed_by_name = ${q(RECONCILE_ACTOR)}
               and hh.from_status in ('cancelled', 'trashed')
             order by hh.changed_at asc
             limit 1) h on true
     where o.mex_tracking_id is not null
       and o.status in ('paid', 'returned', 'shipped')
       and (coalesce(o.price, 0) = 0 or o.product_name is null
            or o.product_name ~* '(cancelled|trashed|no prior product on file)'
            or o.product_name !~ '[[:alnum:]]')`);
  // exact mirror of the UI rule; the SQL above is only a superset
  return rows.filter((g) => Number(g.price || 0) === 0 || isSyntheticProductName(g.product_name));
}

const PARCEL_COLS = `tracking_id, account, series, status_id, status_name, cod_mkd, receiver_name, receiver_city,
  phone8, created_at_mex, delivered_at, returned_at, last_update_at, order_id, link_method`;

export async function loadParcelsByTracking(trackings) {
  const list = [...new Set(trackings.filter(Boolean))];
  const out = [];
  for (let i = 0; i < list.length; i += 1000) {
    out.push(...await sqlRead(`select ${PARCEL_COLS} from public.mex_parcels where tracking_id = any(${qTextArray(list.slice(i, i + 1000))})`));
  }
  return out;
}

const HOLDER_COLS = `o.id, o.display_id, o.status::text as status, o.price, o.product_name, o.quantity,
  o.source_type, o.external_source, o.external_order_id, o.created_at, o.mex_tracking_id,
  o.customer_name, o.customer_phone, o.customer_city`;

export async function loadHolders(trackings) {
  const list = [...new Set(trackings.filter(Boolean))];
  const out = [];
  for (let i = 0; i < list.length; i += 1000) {
    out.push(...await sqlRead(`select ${HOLDER_COLS}
      from public.orders o where o.mex_tracking_id = any(${qTextArray(list.slice(i, i + 1000))})`));
  }
  return out;
}

/** Every order whose tracking id another order also names (orders side). */
export async function loadDoubleHolders() {
  return sqlRead(`select ${HOLDER_COLS}
    from public.orders o
   where o.mex_tracking_id in (select mex_tracking_id from public.orders
                                where mex_tracking_id is not null group by 1 having count(*) > 1)`);
}

/** The collabBox import whose DocNumber IS this tracking id (the backfill's ownership proof). */
export const isDocHolder = (o, tracking) => o.external_source === COLLABBOX && String(o.external_order_id || '') === String(tracking);

export async function loadCandidates(keys8) {
  const list = [...new Set(keys8.filter((k) => k && k.length === 8))];
  const out = [];
  for (let i = 0; i < list.length; i += 500) {
    out.push(...await sqlRead(`select o.id, o.display_id, o.status::text as status, o.price, o.product_name,
        o.source_type, o.created_at, o.mex_tracking_id, o.customer_phone, o.customer_name,
        right(regexp_replace(o.customer_phone, '\\D', '', 'g'), 8) as phone8,
        exists (select 1 from public.mex_parcels mp where mp.order_id = o.id) as has_register_link
      from public.orders o
     where right(regexp_replace(o.customer_phone, '\\D', '', 'g'), 8) = any(${qTextArray(list.slice(i, i + 500))})`));
  }
  return out;
}

// ─── classification (pure — no I/O) ─────────────────────────────────────────
const statusTarget = (p) => (Number(p.status_id) === 2 ? 'paid' : Number(p.status_id) === 7 ? 'returned' : 'shipped');

/**
 * @returns {{ units, csv, counts, lines, falls?:never, changes: Map, byRule }}
 *   units — actionable plan units for applyUnits (B1/B2/B3)
 *   csv   — one row per ghost (every rule, incl. manual/excluded) for the owner
 *   lines — the hash lines of EVERY ghost (and of R/holder rows of actionable units)
 */
export function classifyGhosts({ ghosts, parcels, holders, candidates, payout = new Set(), hold = new Set(), runTag = 'dry-run',
  today = fmtSkopjeDate(Date.now()), holdersFollowParcel = true }) {
  const ghostIds = new Set(ghosts.map((g) => g.id));
  const parcelBy = new Map(parcels.map((p) => [p.tracking_id, p]));
  const holdersBy = new Map();
  for (const h of holders) (holdersBy.get(h.mex_tracking_id) ?? holdersBy.set(h.mex_tracking_id, []).get(h.mex_tracking_id)).push(h);
  const cand8 = new Map();
  for (const c of candidates) (cand8.get(c.phone8) ?? cand8.set(c.phone8, []).get(c.phone8)).push(c);

  // pass 1 — per ghost
  const tent = [...ghosts].sort((a, b) => String(a.display_id).localeCompare(String(b.display_id))).map((g) => {
    const T = g.mex_tracking_id;
    const P = parcelBy.get(T) || null;
    const t = { g, T, P, kind: null, why: '' };
    const held = hold.has(g.display_id);
    if (held) return { ...t, kind: 'manual', why: 'held back with --hold' };
    if (!['cancelled', 'trashed'].includes(g.orig_status)) return { ...t, kind: 'manual', why: `unexpected original status ${g.orig_status}` };
    if (g.source_type !== 'manual' || Number(g.item_count) > 0) {
      return { ...t, kind: 'manual', why: `not an agent disposition row (${g.source_type}, ${g.item_count} item(s)) — a real product order with price 0; the parcel may be its own` };
    }
    if (!P) return { ...t, kind: 'manual', why: 'parcel not in the MEX register — run scripts/backfill-mex-register.mjs' };
    const others = (holdersBy.get(T) || []).filter((h) => h.id !== g.id);
    if (others.length) {
      const real = others.filter((h) => !ghostIds.has(h.id));
      if (others.length === 1 && real.length === 1) {
        const O = real[0];
        if (P.order_id && P.order_id !== g.id && P.order_id !== O.id) {
          return { ...t, kind: 'manual', why: 'the register links the parcel to a third order' };
        }
        return { ...t, kind: 'B1', O };
      }
      return { ...t, kind: 'manual', why: `parcel also sits on ${others.map((h) => h.display_id).join(', ')}` };
    }
    if (P.order_id && P.order_id !== g.id) return { ...t, kind: 'manual', why: 'the register links the parcel to another order' };
    const key8 = P.phone8 || phone8(g.customer_phone);
    const pT = toMs(P.created_at_mex);
    const R = pT === null ? [] : (cand8.get(key8) || []).filter((o) => !ghostIds.has(o.id)
      && Number(o.price) > 0
      && !isSyntheticProductName(o.product_name)
      && o.status !== 'duplicated'
      && !o.mex_tracking_id
      && !o.has_register_link
      && toMs(o.created_at) >= pT - 75 * DAY_MS
      && toMs(o.created_at) <= pT + 3 * DAY_MS
      && codFit(o.price, P.cod_mkd));
    return { ...t, kind: 'search', R };
  });

  // pass 2 — a real order that fits two ghosts' parcels is nobody's to take
  const fits = new Map();
  for (const t of tent) if (t.kind === 'search') for (const r of t.R) fits.set(r.id, (fits.get(r.id) || 0) + 1);
  for (const t of tent) {
    if (t.kind !== 'search') continue;
    if (!t.R.length) { t.kind = 'B3'; continue; }
    if (t.R.length > 1) { t.kind = 'manual'; t.why = `${t.R.length} real orders fit the parcel: ${t.R.map((r) => r.display_id).join(', ')}`; continue; }
    const R = t.R[0];
    if (fits.get(R.id) > 1) { t.kind = 'manual'; t.why = `${R.display_id} also fits another ghost's parcel`; continue; }
    if (R.status === 'take') { t.kind = 'manual'; t.why = `${R.display_id} is open in an agent's hands (take)`; continue; }
    if (hold.has(R.display_id)) { t.kind = 'manual'; t.why = 'held back with --hold'; continue; }
    t.kind = 'B2';
    t.R1 = R;
  }
  for (const t of tent) {
    if (t.kind === 'B1' && hold.has(t.O.display_id)) { t.kind = 'manual'; t.why = 'held back with --hold'; }
    const touched = [t.g.id, t.R1?.id, t.O?.id].filter(Boolean);
    t.inPayout = touched.some((id) => payout.has(id));
    if (['B1', 'B2', 'B3'].includes(t.kind) && t.inPayout) { t.kind = 'excluded_payout'; t.why = 'an order of this unit is in agent_payout_items'; }
  }

  // build plan units + CSV + hash lines
  const units = [], csv = [], lines = [];
  const changes = new Map();
  for (const t of tent) {
    const { g, T, P } = t;
    const flipDate = fmtSkopjeDate(g.flipped_at);
    const parcelTxt = P ? `${P.status_name || `status ${P.status_id}`}, COD ${fmtMkd(P.cod_mkd)} ден` : 'not in the register';
    const target = g.orig_status;
    const base = {
      rule: t.kind, ghost: g.display_id, ghost_status: g.status, ghost_target: ['B1', 'B2', 'B3'].includes(t.kind) ? target : '',
      original_status: g.orig_status, flipped_to: g.flipped_to, flipped_at: fmtSkopje(g.flipped_at),
      agent: g.assigned_agent_name || '', list: g.prediction_list_name || '', ghost_source: g.source_type,
      customer: g.customer_name, phone: g.customer_phone, city: g.customer_city, ghost_created: fmtSkopje(g.created_at),
      tracking: T, account: P?.account || '', series: P?.series || '', parcel_status: P ? `${P.status_id} ${P.status_name || ''}`.trim() : '',
      cod_mkd: P?.cod_mkd ?? '', parcel_created: fmtSkopje(P?.created_at_mex), delivered_at: fmtSkopje(P?.delivered_at), returned_at: fmtSkopje(P?.returned_at),
      real_order: t.R1?.display_id || t.O?.display_id || '', real_status: t.R1?.status || t.O?.status || '',
      real_target: t.R1 ? statusTarget(P) : '', real_price_mkd: t.R1 ? expectedCodMkd(t.R1.price) : (t.O ? expectedCodMkd(t.O.price) : ''),
      cod_fit: t.R1 ? codFit(t.R1.price, P.cod_mkd) : '', why: t.why, in_payout: t.inPayout ? 'yes' : '',
    };

    if (!['B1', 'B2', 'B3'].includes(t.kind)) {
      lines.push(planLine(g.id, t.kind, '', T));
      csv.push({ ...base, trash_effect: '' });
      continue;
    }

    const reasonNote = `original reason wiped when MEX parcel ${T} was mis-attached on ${flipDate}; restored ${today}`;
    const isCancel = target === 'cancelled';
    const parkNote = trashParkNote(T, P);
    const ghostRow = {
      unit: g.id, order_id: g.id, rule: t.kind, line: planLine(g.id, t.kind, target, T),
      expect_status: g.status, expect_tracking: T,
      set: revertDispositionSet({ revertTo: target, at: g.created_at, cancelNote: reasonNote, trashNote: parkNote }),
      link: null,
      unlink: t.kind === 'B3' && P.order_id === g.id ? T : null,
      history: { from: g.status, to: target },
      evidence: {
        key: KEY, ghost: g.display_id, tracking: T, account: P.account, parcel_status: P.status_id, cod_mkd: P.cod_mkd,
        original_status: g.orig_status, flipped_to: g.flipped_to, flipped_at: g.flipped_at,
        real_order: t.R1?.display_id || t.O?.display_id || null,
      },
      note: null,
    };
    const head = `Repair ${KEY} (run ${runTag}): this 0 ден ${isCancel ? 'cancellation' : 'trash'} record` +
      `${g.assigned_agent_name ? ` by ${g.assigned_agent_name}` : ''} was given MEX parcel ${T} by the reconciliation` +
      ` fallback on ${flipDate} and flipped to ${g.flipped_to}. That was wrong — it is an agent's call outcome, not a sale.` +
      (isCancel
        ? ` Restored to cancelled; the original reason was wiped by the mis-attach, so it now reads "other".`
        : ` Restored to trashed as not_reachable (the 21-day park, counted from ${fmtSkopjeDate(g.created_at)}): ${parkNote}.`);
    const rows = [ghostRow];
    changes.set(g.id, isCancel ? { status: 'cancelled' } : { status: 'trashed', trashed_at: g.created_at, trash_reason: 'not_reachable' });

    if (t.kind === 'B1') {
      const O = t.O;
      const doc = isDocHolder(O, T);
      const follow = holdersFollowParcel ? mexTargetFor(O.status, P) : null;
      ghostRow.note = `${head} The parcel belongs to ${O.display_id} (${O.source_type}${doc ? ', its collabBox document number is this tracking id' : ''}), which already carries it.`;
      ghostRow.evidence.holder_is_doc = doc;
      t.follow = follow;
      if (P.order_id !== O.id || follow) {
        rows.push({
          unit: g.id, order_id: O.id, rule: 'B1_holder', line: planLine(O.id, 'B1_holder', follow || '', T),
          expect_status: O.status, expect_tracking: O.mex_tracking_id,
          set: follow ? mexStatusSet(follow, P) : {},
          link: P.order_id !== O.id ? { tracking: T, method: doc ? 'collabbox_import' : 'repair', force: !!P.order_id, expectOwner: P.order_id || null } : null,
          unlink: null,
          history: follow ? { from: O.status, to: follow } : null,
          note: `Repair ${KEY} (run ${runTag}): MEX parcel ${T} was also attached to the 0 ден record ${g.display_id}; that link is removed, so this order is now the parcel's only holder.` +
            (follow ? ` The reconcile kept updating the 0 ден record instead of this order, so its status lagged: ${O.status} → ${follow} per MEX (${parcelWord(P)}).` : ''),
          evidence: { key: KEY, ghost: g.display_id, tracking: T, account: P.account, role: 'holder', holder_is_doc: doc, status_follow: follow },
        });
        if (follow) changes.set(O.id, { status: follow });
      }
    } else if (t.kind === 'B2') {
      const R = t.R1;
      const tgt = statusTarget(P);
      const fit = codFit(R.price, P.cod_mkd);
      const set = {
        cancellation_reason: null, cancellation_reason_notes: null, cancelled_at: null,
        trash_reason: null, trash_reason_notes: null, trashed_at: null,
      };
      if (R.status !== tgt) set.status = tgt;
      const paidAt = isoOrNull(P.delivered_at ?? P.last_update_at ?? P.created_at_mex) ?? NOW;
      if (tgt === 'paid') Object.assign(set, { paid_at: paidAt, returned_at: null, paid_basis: 'mex' });
      else if (tgt === 'returned') Object.assign(set, { returned_at: isoOrNull(P.returned_at ?? P.last_update_at) ?? NOW, paid_at: null, paid_basis: null });
      else Object.assign(set, { shipped_at: isoOrNull(P.created_at_mex) ?? NOW, returned_at: null, paid_at: null, paid_basis: null });
      ghostRow.note = `${head} The parcel (${parcelTxt}) belongs to ${R.display_id} — same phone, COD fits its price — and is moved there.`;
      rows.push({
        unit: g.id, order_id: R.id, rule: 'B2_real', line: planLine(R.id, 'B2_real', tgt, T),
        expect_status: R.status, expect_tracking: null,
        set,
        link: { tracking: T, method: 'repair', force: !!P.order_id, expectOwner: P.order_id || null },
        unlink: null,
        history: R.status !== tgt ? { from: R.status, to: tgt } : null,
        note: `Repair ${KEY} (run ${runTag}): MEX ${P.account || ''} parcel ${T} (${parcelTxt}) belongs to this order — same phone,` +
          ` COD fits ${fmtMkd(expectedCodMkd(R.price))} ден${fit === 'plus_delivery' ? ' + 150 ден delivery' : ''} — but on ${flipDate}` +
          ` it was attached to the 0 ден record ${g.display_id}. Linked here; status ${R.status} → ${tgt} per MEX` +
          `${tgt === 'paid' ? `, paid date = MEX delivery ${fmtSkopje(paidAt === NOW ? Date.now() : paidAt)}` : ''}.`,
        evidence: {
          key: KEY, ghost: g.display_id, tracking: T, account: P.account, parcel_status: P.status_id, cod_mkd: P.cod_mkd,
          price_mkd: expectedCodMkd(R.price), cod_fit: fit, parcel_created: P.created_at_mex, delivered_at: P.delivered_at,
          returned_at: P.returned_at, match: 'phone8+cod+window',
        },
      });
      changes.set(R.id, { status: tgt });
    } else {
      ghostRow.note = `${head} No CRM order matches the parcel (${parcelTxt}), so it stays unlinked as a MEX-only sale.`;
    }
    units.push({ unit: g.id, rows });
    for (const r of rows) lines.push(r.line);
    csv.push({ ...base, real_target: base.real_target || t.follow || '', ghost_reason: isCancel ? 'other' : 'not_reachable', trash_effect: '' });
  }

  const counts = { total: ghosts.length };
  for (const t of tent) counts[t.kind] = (counts[t.kind] || 0) + 1;
  counts.B1_holder_follow = tent.filter((t) => t.kind === 'B1' && t.follow).length;
  const byRule = tally(tent, (t) => t.kind, (t) => t.P?.cod_mkd || 0);
  return { units, csv, lines, counts, byRule, changes, tent };
}

/**
 * Rule D — tracking ids named by two or more orders where no holder is a ghost (a ghost's
 * tracking id is B1's business). Exactly one collabBox DocNumber holder C → it takes the
 * parcel (force clears the others) and its status follows the parcel; every other holder X
 * whose status the MEX reconcile set from THIS parcel out of a cancel/trash goes back to it
 * (D_revert); any other X keeps its status and is listed (D_other). No DocNumber holder, or
 * several → D_manual.
 * @returns {{ units, csv, lines, counts, changes }}
 */
export function classifyDoubles({ doubleHolders, parcels, ghostIds, mexNotes = [], history = [], payout = new Set(), hold = new Set(),
  runTag = 'dry-run', today = fmtSkopjeDate(Date.now()) }) {
  const parcelBy = new Map(parcels.map((p) => [p.tracking_id, p]));
  const byT = new Map();
  for (const h of doubleHolders) (byT.get(h.mex_tracking_id) ?? byT.set(h.mex_tracking_id, []).get(h.mex_tracking_id)).push(h);
  const notesBy = new Map();
  for (const n of mexNotes) (notesBy.get(n.order_id) ?? notesBy.set(n.order_id, []).get(n.order_id)).push(n);
  const statusFromParcel = (o, T) => {
    const n = (notesBy.get(o.id) || []).filter((x) => String(x.text).includes(T)).pop();
    return n ? `${fmtSkopjeDate(n.created_at)}: ${String(n.text).slice(0, 160)}` : '';
  };
  const units = [], csv = [], lines = [];
  const changes = new Map();
  const counts = { D: 0, D_manual: 0, D_excluded_payout: 0, D_owner_follow: 0, D_revert: 0, D_other: 0 };
  const trackings = [...byT.keys()].sort();
  for (const T of trackings) {
    const hs = byT.get(T).sort((a, b) => String(a.display_id).localeCompare(String(b.display_id)));
    if (hs.length < 2 || hs.some((h) => ghostIds.has(h.id))) continue;
    const P = parcelBy.get(T) || null;
    const docs = hs.filter((h) => isDocHolder(h, T));
    let rule = 'D', why = '';
    if (docs.length !== 1) { rule = 'D_manual'; why = docs.length ? `${docs.length} holders carry this collabBox document number` : 'no holder is the collabBox document of this tracking id'; }
    else if (!P) { rule = 'D_manual'; why = 'parcel not in the MEX register'; }
    else if (P.order_id && !hs.some((h) => h.id === P.order_id)) { rule = 'D_manual'; why = 'the register links the parcel to an order that does not name it'; }
    else if (hs.some((h) => hold.has(h.display_id))) { rule = 'D_manual'; why = 'held back with --hold'; }
    else if (hs.some((h) => payout.has(h.id))) { rule = 'D_excluded_payout'; why = 'a holder is in agent_payout_items'; }
    counts[rule]++;
    const C = rule === 'D' ? docs[0] : null;
    const parcelTxt = P ? `${P.status_id} ${P.status_name || ''}`.trim() : '';
    const follow = C ? mexTargetFor(C.status, P) : null;
    if (follow) counts.D_owner_follow++;
    const plans = new Map(); // X id → revert analysis
    for (const X of C ? hs.filter((h) => h.id !== C.id) : []) {
      const rv = mexFlipRevert({ order: X, history, notes: mexNotes, tracking: T });
      plans.set(X.id, rv);
      counts[rv.ok ? 'D_revert' : 'D_other']++;
    }
    for (const h of hs) {
      const rv = plans.get(h.id);
      const role = C ? (h.id === C.id ? 'owner (collabBox document)' : 'loses the parcel') : 'holder';
      const target = C ? (h.id === C.id ? (follow || '') : (rv?.ok ? rv.revertTo : '')) : '';
      csv.push({
        rule: C ? (h.id === C.id ? 'D' : (rv?.ok ? 'D_revert' : 'D_other')) : rule, why, tracking: T, account: P?.account || '',
        parcel_status: parcelTxt, cod_mkd: P?.cod_mkd ?? '',
        parcel_created: fmtSkopje(P?.created_at_mex), delivered_at: fmtSkopje(P?.delivered_at), returned_at: fmtSkopje(P?.returned_at),
        register_owner: P?.order_id ? (hs.find((x) => x.id === P.order_id)?.display_id || P.order_id) : '',
        order: h.display_id, role, status: h.status, target,
        source: h.source_type, external: h.external_source ? `${h.external_source} ${h.external_order_id || ''}`.trim() : '',
        created: fmtSkopje(h.created_at), price_mkd: expectedCodMkd(h.price), cod_fit: P ? (codFit(h.price, P.cod_mkd) || '') : '',
        product: h.product_name, customer: h.customer_name, phone: h.customer_phone, city: h.customer_city,
        status_set_from_this_parcel: statusFromParcel(h, T),
        review: C && h.id !== C.id && !rv?.ok && ['paid', 'returned', 'shipped'].includes(h.status)
          ? `keeps ${h.status} with no parcel of its own — decide (${rv?.why || ''})` : '',
      });
      const lineRule = C ? (h.id === C.id ? 'D' : (rv?.ok ? 'D_revert' : 'D_other')) : rule;
      lines.push(planLine(h.id, lineRule, target, T));
    }
    if (rule !== 'D') continue;
    const others = hs.filter((h) => h.id !== C.id);
    const rows = [{
      unit: `dbl:${T}`, order_id: C.id, rule: 'D', line: planLine(C.id, 'D', follow || '', T),
      expect_status: C.status, expect_tracking: T,
      set: follow ? mexStatusSet(follow, P) : {},
      link: { tracking: T, method: 'collabbox_import', force: true, expectOwner: P.order_id || null },
      unlink: null,
      history: follow ? { from: C.status, to: follow } : null,
      note: `Repair ${KEY} (run ${runTag}): MEX parcel ${T} was named by this order and by ${others.map((x) => x.display_id).join(', ')}.` +
        ' Its collabBox document number is the tracking id, so the parcel is this order\'s; the other link is removed.' +
        (follow ? ` Its status lagged the parcel: ${C.status} → ${follow} per MEX (${parcelWord(P)}) — owner decision 2026-09-27, MEX decides.` : ''),
      evidence: { key: KEY, tracking: T, role: 'owner', rule: 'collabbox_docnumber', others: others.map((x) => x.display_id),
        parcel_status: P.status_id, cod_mkd: P.cod_mkd, status_follow: follow },
    }];
    if (follow) changes.set(C.id, { status: follow });
    for (const X of others) {
      const rv = plans.get(X.id);
      if (rv.ok) {
        const flipDate = fmtSkopjeDate(rv.flip.changed_at);
        const cancelNote = `original reason wiped when MEX parcel ${T} was mis-matched on ${flipDate}; the parcel belongs to ${C.display_id}; restored ${today}`;
        rows.push({
          unit: `dbl:${T}`, order_id: X.id, rule: 'D_revert', line: planLine(X.id, 'D_revert', rv.revertTo, T),
          expect_status: X.status, expect_tracking: T,
          set: revertDispositionSet({ revertTo: rv.revertTo, at: rv.originAt, cancelNote, trashNote: trashParkNote(T, P) }),
          link: null, unlink: null,
          history: { from: X.status, to: rv.revertTo },
          note: `Repair ${KEY} (run ${runTag}): on ${flipDate} the MEX reconcile gave this order parcel ${T} and flipped it` +
            ` ${rv.flip.from_status} → ${rv.flip.to_status}. The parcel is ${C.display_id}'s (its collabBox document number is the tracking id),` +
            ` so this order goes back to ${rv.revertTo}` +
            (rv.revertTo === 'trashed' ? ` as not_reachable: ${trashParkNote(T, P)}.` : '; its original reason was wiped, so it reads "other".'),
          evidence: { key: KEY, tracking: T, role: 'loses_parcel', owner: C.display_id, revert_to: rv.revertTo, flipped_at: rv.flip.changed_at, sold_before_flip: rv.soldBefore },
        });
        changes.set(X.id, rv.revertTo === 'trashed'
          ? { status: 'trashed', trashed_at: rv.originAt, trash_reason: 'not_reachable' } : { status: 'cancelled' });
      } else {
        rows.push({
          unit: `dbl:${T}`, order_id: X.id, rule: 'D_other', line: planLine(X.id, 'D_other', '', T),
          expect_status: X.status, expect_tracking: T,
          set: {}, link: null, unlink: null, history: null,
          note: `Repair ${KEY} (run ${runTag}): MEX parcel ${T} belongs to ${C.display_id} (its collabBox document number is the tracking id);` +
            ` this order named it too, and that link is removed. Status ${X.status} was left as it is (${rv.why}) — it needs a decision.`,
          evidence: { key: KEY, tracking: T, role: 'loses_parcel', owner: C.display_id, kept_status_because: rv.why },
        });
      }
    }
    units.push({ unit: `dbl:${T}`, rows });
  }
  return { units, csv, lines, counts, changes };
}

// ─── main ───────────────────────────────────────────────────────────────────
const USAGE = `usage: node scripts/repair-mex-ghost-links.mjs [--expect k=n,...] [--hold ORD-1,ORD-2] [--holders-keep-status]
       node scripts/repair-mex-ghost-links.mjs --apply --run <id> --guards-live [--actor <email>] [--chunk 200] [--holders-keep-status]`;

async function main() {
  const args = parseArgs(process.argv.slice(2), {
    flags: ['apply', 'guards-live', 'holders-keep-status', 'help'],
    values: ['run', 'expect', 'actor', 'chunk', 'hold'],
  });
  if (args.help) { console.log(USAGE); return; }
  mkGuard();
  const APPLY = !!args.apply;
  console.log(bold(`\nRepair B — ${KEY} — ${APPLY ? 'APPLY' : 'DRY RUN'}  (${MK_REF})\n`));
  if (APPLY && !args.run) die('--apply needs --run <id> (printed by the dry run).');
  if (APPLY && !args['guards-live']) {
    die('--apply needs --guards-live: confirm the Phase-1 mex-reconcile (no fallback onto 0 ден rows) is DEPLOYED,\n' +
      '  or its next run can re-attach the B3 parcels to the ghosts this repair restores.');
  }
  await assertRemoteIsMk();
  await requireRepairSchema({ forApply: APPLY });
  const hold = new Set(String(args.hold || '').split(',').map((s) => s.trim()).filter(Boolean));
  const expected = parseExpect(args.expect, EXPECTED);

  // 1. load
  const ghosts = await loadGhosts();
  const trackings = ghosts.map((g) => g.mex_tracking_id);
  const [parcels, holders] = await Promise.all([loadParcelsByTracking(trackings), loadHolders(trackings)]);
  const keys8 = [...new Set([...parcels.map((p) => p.phone8), ...ghosts.map((g) => phone8(g.customer_phone))])];
  const candidates = await loadCandidates(keys8);
  const doubleHolders = await loadDoubleHolders();
  const doubleTrackings = [...new Set(doubleHolders.map((h) => h.mex_tracking_id))];
  const doubleParcels = await loadParcelsByTracking(doubleTrackings);
  const mexNotes = await loadMexNotes(doubleHolders.map((h) => h.id));
  const doubleHistory = await loadHistory(doubleHolders.map((h) => h.id));
  const payout = await loadPayoutOrderIds([...ghosts.map((g) => g.id), ...candidates.map((c) => c.id), ...holders.map((h) => h.id), ...doubleHolders.map((h) => h.id)]);
  ok(`${ghosts.length} ghosts · ${parcels.length} of their parcels in the register · ${candidates.length} orders on those phones`);
  ok(`${doubleTrackings.length} tracking ids named by more than one order`);

  // 2. classify
  const runTag = APPLY ? String(args.run).slice(0, 8) : 'dry-run';
  const holdersFollowParcel = !args['holders-keep-status'];
  const plan = classifyGhosts({ ghosts, parcels, holders, candidates, payout, hold, runTag, holdersFollowParcel });
  const dbl = classifyDoubles({ doubleHolders, parcels: doubleParcels, ghostIds: new Set(ghosts.map((g) => g.id)), mexNotes, history: doubleHistory, payout, hold, runTag });
  const allUnits = [...plan.units, ...dbl.units];
  const allLines = [...plan.lines, ...dbl.lines];

  // 3. pre-checks
  const phoneOf = new Map([...candidates, ...holders, ...doubleHolders, ...ghosts].map((o) => [o.id, o.customer_phone]));
  const phoneRows = await loadPhoneOrders(allUnits.flatMap((u) => u.rows).map((r) => phoneOf.get(r.order_id)).filter(Boolean));
  const trash = stickyTrashEffects(phoneRows, new Map([...plan.changes, ...dbl.changes]));
  const effectOf = new Map();
  for (const f of trash.falls) for (const d of f.orders) effectOf.set(d, f.kind === 'parked' ? `parked (not_reachable) until ${fmtSkopjeDate(f.until)}` : `falls into PERMANENT Trash — held by ${f.by}`);
  for (const f of trash.released) for (const d of f.orders) effectOf.set(d, 'released from Trash');
  for (const row of plan.csv) row.trash_effect = effectOf.get(row.ghost) || effectOf.get(row.real_order) || '';
  for (const row of dbl.csv) row.trash_effect = effectOf.get(row.order) || '';
  const confirmedTargets = allUnits.flatMap((u) => u.rows).filter((r) => r.set?.status === 'confirmed');
  if (confirmedTargets.length) die(`${confirmedTargets.length} rows would be set to confirmed — refusing (warehouse export queue).`);

  // 4. report
  console.log(bold('\nClassification'));
  printTable(Object.entries(plan.byRule).map(([rule, v]) => ({ rule, ghosts: v.orders, 'parcel COD (ден)': fmtMkd(v.mkd) })));
  const b2 = plan.units.flatMap((u) => u.rows).filter((r) => r.rule === 'B2_real');
  const b2t = tally(b2, (r) => `${r.expect_status} → ${r.set.status || r.expect_status}`);
  if (b2.length) {
    console.log(bold('B2 — the real orders that get their parcel back'));
    printTable(Object.entries(b2t).map(([move, v]) => ({ move, orders: v.orders })));
  }
  const manual = plan.csv.filter((r) => !['B1', 'B2', 'B3'].includes(r.rule));
  if (manual.length) {
    console.log(bold(`\nNot touched — for a human (${manual.length})`));
    for (const r of manual) console.log(`  ${r.ghost.padEnd(11)} ${r.rule.padEnd(15)} ${r.tracking}  ${r.why}`);
  }
  const b1f = plan.units.flatMap((u) => u.rows).filter((r) => r.rule === 'B1_holder' && r.set?.status);
  if (b1f.length) {
    console.log(bold(`B1 holders whose status follows their parcel${holdersFollowParcel ? '' : ' (OFF: --holders-keep-status)'}`));
    printTable(Object.entries(tally(b1f, (r) => `${r.expect_status} → ${r.set.status}`)).map(([move, v]) => ({ move, orders: v.orders })));
  }
  console.log(bold(`\nD — tracking ids named by two orders, no ghost among them (${dbl.counts.D + dbl.counts.D_manual + dbl.counts.D_excluded_payout})`));
  console.log(`  D (the collabBox document holder takes the parcel): ${dbl.counts.D} · D_manual: ${dbl.counts.D_manual} · excluded (payout): ${dbl.counts.D_excluded_payout}`);
  console.log(`  owners whose status follows the parcel: ${dbl.counts.D_owner_follow} · holders reverted to their cancel/trash: ${dbl.counts.D_revert} · holders left as they are: ${dbl.counts.D_other}`);
  const dRows = dbl.units.flatMap((u) => u.rows).filter((r) => r.set?.status);
  if (dRows.length) printTable(Object.entries(tally(dRows, (r) => `${r.rule}: ${r.expect_status} → ${r.set.status}${r.set.trash_reason ? ` (${r.set.trash_reason})` : ''}`)).map(([move, v]) => ({ move, orders: v.orders })));
  for (const r of dbl.csv.filter((x) => x.rule === 'D_manual' || x.rule === 'D_excluded_payout')) console.log(`    ${r.tracking}  ${r.order.padEnd(11)} ${r.status}/${r.source}  ${r.why}`);
  const review = dbl.csv.filter((r) => r.review);
  if (review.length) {
    console.log(`  left for a decision (status kept, parcel removed): ${review.length}`);
    for (const r of review) console.log(`    ${r.order.padEnd(11)} ${r.review}`);
  }

  console.log(bold('\nPre-checks'));
  console.log(`  orders in agent_payout_items: ${(plan.counts.excluded_payout || 0) + dbl.counts.D_excluded_payout}`);
  console.log(`  would set status 'confirmed': 0`);
  const trashCount = printTrashFalls(trash);
  console.log(`  customers released from Trash (an order becomes paid): ${trash.released.length}`);

  const stamp = fileStamp();
  const csvPath = writeCsv(`${KEY}-${APPLY ? 'apply-' : ''}${stamp}.csv`, plan.csv);
  const dblPath = writeCsv(`${KEY}-doubles-${APPLY ? 'apply-' : ''}${stamp}.csv`, dbl.csv);
  ok(`CSV (contains PII — stays in exports/, never commit): ${csvPath}`);
  ok(`CSV (double-held tracking ids): ${dblPath}`);

  // 5. dry run → drift check → ledger row
  if (!APPLY) {
    const counts = { total: plan.counts.total, B1: plan.counts.B1 || 0, B2: plan.counts.B2 || 0, B3: plan.counts.B3 || 0,
      manual: (plan.counts.manual || 0) + (plan.counts.excluded_payout || 0),
      D: dbl.counts.D, D_manual: dbl.counts.D_manual + dbl.counts.D_excluded_payout,
      D_revert: dbl.counts.D_revert, D_owner_follow: dbl.counts.D_owner_follow, B1_holder_follow: plan.counts.B1_holder_follow || 0,
      trash_permanent: trashCount.permanent };
    const drift = checkDrift(counts, expected);
    console.log(bold('\nExpected vs actual'));
    printTable(drift.rows);
    if (!drift.pass) {
      die('Counts drifted more than ±2 % from the expected ones — NO run recorded.\n' +
        '  Read the CSV; if the difference is understood, re-run with\n' +
        `  --expect ${expectString(counts, Object.keys(expected))}`);
    }
    const summary = {
      script: 'repair-mex-ghost-links.mjs', expected, counts: { ...plan.counts, ...dbl.counts },
      parcel_cod_mkd_by_rule: Object.fromEntries(Object.entries(plan.byRule).map(([k, v]) => [k, v.mkd])),
      b2_moves: Object.fromEntries(Object.entries(b2t).map(([k, v]) => [k, v.orders])),
      manual: manual.map((r) => ({ ghost: r.ghost, rule: r.rule, why: r.why })),
      doubles_manual: dbl.csv.filter((r) => ['D_manual', 'D_excluded_payout'].includes(r.rule)).map((r) => ({ tracking: r.tracking, order: r.order, why: r.why })),
      doubles_to_decide: review.map((r) => ({ order: r.order, review: r.review })),
      options: { holders_follow_parcel: holdersFollowParcel },
      trash_falls_permanent: trashCount.permanent, trash_falls_parked: trashCount.parked, trash_released: trash.released.length,
      csv: [csvPath, dblPath].map((p) => p.split(/[\\/]/).pop()),
    };
    const { id, hash } = await recordDryRun({ key: KEY, lines: allLines, summary });
    console.log(bold(`\nDry run recorded: ${green(id)}`) + `  (hash ${hash.slice(0, 12)}…)`);
    console.log('Nothing was written to orders. After review, in the quiet window (after 20:55 Skopje):');
    console.log(`  node scripts/assert-mk-target.mjs`);
    console.log(`  node scripts/repair-mex-ghost-links.mjs --apply --run ${id} --guards-live\n`);
    return;
  }

  // 6. apply
  const fns = await edgeFunctionInfo(['mex-reconcile']);
  console.log(`  mex-reconcile: ${fns['mex-reconcile']} — you confirmed (--guards-live) this is the Phase-1 build.`);
  const actor = await resolveActor(args.actor || 'mile@elyon.com');
  ok(`recorded as ${actor.email}`);
  const { done } = await verifyRunForApply({ key: KEY, runId: args.run, lines: allLines, options: { holders_follow_parcel: holdersFollowParcel } });
  const units = allUnits.filter((u) => !u.rows.some((r) => done.has(r.order_id)));
  const typeMap = await loadOrderColumnTypes();
  console.log(bold(`\nApplying ${units.length} units (${units.reduce((n, u) => n + u.rows.length, 0)} orders)`));
  const stats = await applyUnits({ key: KEY, runId: args.run, units, typeMap, chunkSize: args.chunk });
  const payload = {
    script: 'repair-mex-ghost-links.mjs', counts: { ...plan.counts, ...dbl.counts }, applied_orders: stats.applied, links: stats.links,
    skipped_moved: stats.skipped, chunks: `${stats.committed}/${stats.chunks}`, resumed_from: done.size,
  };
  if (stats.failed) {
    await auditPartial({ key: KEY, runId: args.run, actor, payload: { ...payload, failed: stats.failed } });
    die(`Stopped at chunk ${stats.failed.chunk}; ${stats.committed} chunk(s) committed and are in the ledger.\n` +
      `  Fix the cause, then re-run the same --apply command: it resumes after the committed chunks.`);
  }
  await finalizeRun({ key: KEY, runId: args.run, actor, payload });
  ok(`run ${args.run} applied — ${stats.applied} orders, ${stats.links} parcel links${stats.skipped.length ? `, ${stats.skipped.length} left alone (moved since the dry run)` : ''}`);

  // 7. verify
  const [v] = await sqlRead(`select
      (select count(*) from public.data_repair_rows where run_id = ${qUuid(args.run)} and after is not null)::int as ledger_rows,
      (select count(*) from public.data_repair_rows r join public.orders o on o.id = r.order_id
        where r.run_id = ${qUuid(args.run)} and o.status = 'confirmed')::int as now_confirmed,
      (select count(*) from public.orders where id = any(${qUuidArray(ghosts.map((g) => g.id))})
        and status in ('paid','returned','shipped'))::int as ghosts_still_sold,
      (select count(*) from (select mex_tracking_id from public.orders where mex_tracking_id is not null
        group by 1 having count(*) > 1) d)::int as trackings_on_two_orders`);
  console.log(bold('\nVerification'));
  printTable([v]);
  const untouched = (plan.counts.total || 0) - (plan.counts.B1 || 0) - (plan.counts.B2 || 0) - (plan.counts.B3 || 0);
  if (v.now_confirmed) warn('some repaired orders sit in confirmed — investigate now.');
  console.log(`  ghosts still paid/returned/shipped: ${v.ghosts_still_sold} (expected ≈ ${untouched + stats.skipped.length}: manual + excluded + moved)`);
  console.log(`  tracking ids still on two orders: ${v.trackings_on_two_orders} (expected ≈ ${dbl.counts.D_manual + dbl.counts.D_excluded_payout} D_manual + the ghosts left manual)`);
  console.log(yellow('  Next: node scripts/engine-fixture-mk.mjs, then the A dry run (repair-altercpa-catchup-paid.mjs).\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => die(e.stack || e.message || String(e)));
}
