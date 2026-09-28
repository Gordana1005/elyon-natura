/**
 * cod-price — the pure half of scripts/repair-cod-price.mjs.
 *
 * Owner decision 28.09.2026 (HANDOFF §3, law): "COD ≠ CRM price: MEX is right. Set the CRM
 * price to the MEX COD when it differs. Not when COD = price×61.5+150 (delivery fee), and not
 * when COD is 0. Dry-run list first; keep order_items consistent."
 *
 * CANDIDATE: an order whose linked MEX parcel — the parcel it names (orders.mex_tracking_id)
 * AND the register links to it (mex_parcels.order_id = orders.id; the register's link is the
 * only sanctioned one, 20260934000100) — carries cod_mkd > 0 that fits neither
 * round(price × 61,5) ±3 ден nor that +150 ±3 (the kit's codFit), with a real CRM status
 * (confirmed / shipped / delivered / paid / returned).
 * NEW PRICE = cod_mkd / 61,5 € rounded to the cent (orders.price is numeric(10,2)); at that
 * precision round(new price × 61,5) is the COD again, always (the error is ≤ 0,31 ден).
 *
 * EXCLUDED — listed, never re-priced (first reason wins; every reason is in the CSV):
 *   held               --hold
 *   test_phone         a test number (they are deleted by repair-test-phones.mjs)
 *   disposition        synthetic product name / sale_source_detail 'disposition' — a 0 ден
 *                      call-outcome row holding a parcel is a ghost link, not a sale
 *   zero_price         price 0/NULL on a real product — nothing to compare the COD with; the
 *                      classic ghost signature (repair B lists these for a human)
 *   link_not_agreed    the order names the parcel but the register links it elsewhere / not
 *   double_held        the tracking id is named by 2+ live orders (owner: keep both orders;
 *                      the owner-accepted pairs of scripts/data/c8a-accepted-duplicates.json
 *                      are marked, but neither is re-priced — the COD belongs to ONE sale)
 *   suspect_link       the parcel's channel does not belong to the order's source: an
 *                      AlterCPA / affiliate / ElyonCRM order on a NATURA teleshop/social parcel
 *                      (9100/9102/9108), a collabBox teleshop/social order on a BIO NATURAL
 *                      parcel (9110/9103), a web order on a BIO NATURAL parcel, or a parcel
 *                      whose tracking id is ANOTHER CRM order's display id. The series decides
 *                      the channel, never the account (20260940000000's rule — series cross
 *                      accounts at the margins); the account decides only when there is no
 *                      series. A collabBox order holding its own DocNumber is never suspect.
 *   not_a_sale_status  pending / take / call_again / cancelled / trashed / duplicated
 *   in_payout          the order sits in agent_payout_items (payouts are deferred)
 *   items_unscalable   several order_items lines that sum to 0 — no proportion to keep
 *
 * order_items (the api's atomic PUT /orders/:id/items and altercpa-sync's resize are the
 * reference): one line → its total_price = the new total, price_per_unit = round(total/qty,
 * 2); several lines → scaled in proportion to their totals, cents rounded, the remainder on
 * the largest line; no lines (legacy) → only orders.price. Σ total_price = the new price to
 * the cent, checked inside the transaction.
 *
 * QUANTITY changes only when AlterCPA's own record proves it EXACTLY: the lead payload's
 * package count c (goods[0].count ?? count, as altercpa-sync reads it) differs from the CRM
 * quantity and round(c × CRM unit price × 61,5) is the COD ±3 ден — on a one-line (or legacy)
 * order. Then the line's quantity and orders.quantity become c (what altercpa-sync's own
 * resize would have written; product_name stays). Every other explanation — the count fitting
 * only with the 150 ден fee, AlterCPA's total fitting, the COD being k × the CRM price — is
 * REPORTED (column `explained`) and changes nothing but the price.
 *
 * No I/O here.
 */
import {
  MKD_PER_EUR, DELIVERY_MKD, COD_TOLERANCE_MKD, MAX_CHUNK, codFit, expectedCodMkd, isSyntheticProductName,
  planLine, q, qUuid, qJson, fmtMkd, fmtSkopje,
} from './repair-kit.mjs';
import { isTestPhone } from './test-phones.mjs';
import { holdersKey } from './accepted-duplicates.mjs';

export const KEY = 'cod-price';
export const SALE_STATUSES = Object.freeze(['confirmed', 'shipped', 'delivered', 'paid', 'returned']);

// ─── money in integer cents (never float euros) ─────────────────────────────
/**
 * A numeric (string or number) → integer cents, rounded half away from zero exactly as
 * PostgreSQL's round(numeric, 2) — from the decimal digits, never through a float
 * (0.285 * 100 is 28.4999… in binary).
 */
export function toCents(v) {
  if (v === null || v === undefined || v === '') return 0;
  const s = typeof v === 'number' ? v.toFixed(6) : String(v).trim();
  const m = s.match(/^([+-]?)(\d*)(?:\.(\d*))?$/);
  if (!m) return Math.round(Number(v) * 100);
  const [, sign, int = '', frac = ''] = m;
  const f = `${frac}000`.slice(0, 3);
  const cents = Number(int || '0') * 100 + Number(f.slice(0, 2)) + (Number(f[2]) >= 5 ? 1 : 0);
  return sign === '-' ? -cents : cents;
}
export function centsToStr(c) {
  const n = Math.round(Number(c));
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  return `${sign}${Math.trunc(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}
/** The new CRM total for a COD: cod / 61,5 € to the cent (never lands on a half cent). */
export const codToCents = (codMkd) => Math.round((Number(codMkd) * 100) / MKD_PER_EUR);
export const fmtEur = (cents) => `${centsToStr(cents).replace('.', ',')} €`;

// ─── channel families (which MEX series belongs to which source) ────────────
const SERIES_FAMILY = Object.freeze({ 9110: 'elyon', 9103: 'elyon', 9100: 'natura', 9102: 'natura', 9108: 'natura' });
const FAMILY_WORD = { elyon: 'BIO NATURAL (Elyon)', natura: 'NATURA (teleshop / social / web)' };
const COLLAB_DETAIL_FAMILY = Object.freeze({ teleshop: 'natura', social: 'natura', leads: 'elyon', leads_out: 'elyon' });

/** Which account family a parcel belongs to: its series, else ORD-/NTMK ids, else its account. */
export function parcelFamily(p) {
  const s = String(p?.series ?? '');
  if (SERIES_FAMILY[s]) return { family: SERIES_FAMILY[s], by: `series ${s}` };
  const t = String(p?.tracking_id ?? '');
  if (/^ORD-\d+$/i.test(t)) return { family: 'elyon', by: 'a CRM display id' };
  if (/^NTMK/i.test(t) || /^NTMK/i.test(String(p?.sender_reference ?? ''))) return { family: 'natura', by: 'NTMK (web shop)' };
  if (p?.account === 'bio_natural') return { family: 'elyon', by: 'account bio_natural' };
  if (p?.account === 'natura') return { family: 'natura', by: 'account natura' };
  return { family: null, by: 'unknown' };
}

/** JS mirror of public.classify_sale_source (20260935000000) — only for rows still NULL. */
export function classifySaleSource(o) {
  const st = o.source_type, ext = o.external_source;
  if (st === 'monadon_legacy') return ['legacy', 'monadon_legacy'];
  if (st === 'altercpa' || ext === 'altercpa') return ['altercpa', st === 'altercpa' ? 'bridge' : 'history'];
  if (st === 'affiliate') return ['affiliate', 'partner'];
  if (['opencart', 'opencart_abandoned', 'inbound_lead'].includes(st)) return ['web', st];
  if (/^naturatherapy/i.test(String(ext ?? ''))) return ['web', String(ext).toLowerCase()];
  if (ext === 'collabbox') {
    const series = String(o.external_order_id ?? '').split('-')[1] ?? '';
    const map = { 9102: 'teleshop', 9100: 'teleshop', 9108: 'social', 9103: 'leads_out', 9110: 'leads', '': 'unknown' };
    return ['collabbox', map[series] ?? series];
  }
  if (st === 'manual' || st === 'prediction_lead') {
    const detail = !(Number(o.price) > 0) || isSyntheticProductName(o.product_name) ? 'disposition' : o.prediction_list_id ? 'prediction_list' : 'direct';
    return ['elyon_crm', detail];
  }
  return ['legacy', st || 'unknown'];
}
export const saleSourceOf = (o) => (o.sale_source ? [o.sale_source, o.sale_source_detail || ''] : classifySaleSource(o));

/** Which family an order's parcel must come from, by how the order ARRIVED. */
export function orderFamily(o) {
  const [src, detail] = saleSourceOf(o);
  if (src === 'altercpa' || src === 'affiliate' || src === 'elyon_crm') return { family: 'elyon', by: src };
  if (src === 'web') return { family: 'natura', by: 'web' };
  if (src === 'collabbox') {
    const series = String(o.external_order_id ?? '').split('-')[1] ?? '';
    return { family: SERIES_FAMILY[series] ?? COLLAB_DETAIL_FAMILY[detail] ?? null, by: `collabbox ${detail || series || '?'}` };
  }
  return { family: null, by: src || 'unclassified' };
}

/** Why a parcel is a wrong link for this order, or null. */
export function linkSuspicion(o, p) {
  if (!p) return null;
  const t = String(p.tracking_id ?? '');
  if (o.external_source === 'collabbox' && String(o.external_order_id ?? '') === t) return null;   // its own DocNumber
  if (/^ORD-\d+$/i.test(t)) {
    return t.toUpperCase() === String(o.display_id ?? '').toUpperCase() ? null : `the parcel's tracking id is another CRM order's display id (${t})`;
  }
  const pf = parcelFamily(p), of = orderFamily(o);
  if (!pf.family || !of.family || pf.family === of.family) return null;
  return `a ${of.by} order holds a ${FAMILY_WORD[pf.family]} parcel (${pf.by}, account ${p.account || '?'})`;
}

// ─── AlterCPA's own record ──────────────────────────────────────────────────
/** AlterCPA's own order total in денари — same as report-cod-mismatch.mjs altercpaMkd. */
export function altercpaMkd(price, currency) {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return null;
  const cur = String(currency || 'mkd').toLowerCase();
  if (cur === 'mkd') return Math.round(p);
  if (cur === 'eur') return Math.round(p * MKD_PER_EUR);
  return null;
}
/** The package count as altercpa-sync reads it (quantityOf: goods[0].count ?? count). */
export function altercpaCount(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 && n <= 50 && Number.isInteger(n) ? n : null;
}
const within = (a, b) => Math.abs(a - b) <= COD_TOLERANCE_MKD;

/**
 * Why the COD differs, in the owner's words (reporting), and whether AlterCPA PROVES a new
 * package count. unitCents/qty describe the ONE line (or the legacy order); null for
 * multi-line orders.
 */
export function explainCod({ priceCents, cod, qty, unitCents, cpaCount, cpaMkd }) {
  const out = { explained: '', newQty: null, cpaFits: '' };
  const crm = expectedCodMkd(priceCents / 100);
  if (cpaMkd != null) out.cpaFits = within(cpaMkd, cod) ? 'exact' : within(cpaMkd + DELIVERY_MKD, cod) ? '+150' : 'no';
  if (cpaCount && unitCents > 0 && qty && cpaCount !== qty) {
    const byCount = Math.round((cpaCount * unitCents * MKD_PER_EUR) / 100);
    if (within(byCount, cod)) {
      out.explained = `altercpa_count_exact: AlterCPA sold ${cpaCount} × ${fmtEur(unitCents)} = ${fmtMkd(byCount)} ден = the COD (CRM had ${qty})`;
      out.newQty = cpaCount;
      return out;
    }
    if (within(byCount + DELIVERY_MKD, cod)) {
      out.explained = `altercpa_count_plus_delivery: AlterCPA's ${cpaCount} × ${fmtEur(unitCents)} + 150 ден delivery = the COD (CRM had ${qty}) — quantity NOT changed (not exact)`;
      return out;
    }
  }
  if (out.cpaFits === 'exact' || out.cpaFits === '+150') {
    out.explained = `altercpa_total_fits: AlterCPA's own total ${fmtMkd(cpaMkd)} ден${out.cpaFits === '+150' ? ' + 150 delivery' : ''} = the COD — re-priced there, the CRM missed it`;
    return out;
  }
  if (crm > 0) {
    for (let k = 2; k <= 10; k++) {
      if (within(k * crm, cod)) { out.explained = `cod_is_${k}x_price: the COD is ${k} × the CRM price — looks like ${k} packs`; return out; }
      if (within(k * crm + DELIVERY_MKD, cod)) { out.explained = `cod_is_${k}x_price_plus_delivery: the COD is ${k} × the CRM price + 150 ден`; return out; }
    }
  }
  out.explained = cod > crm ? 'cod_above_price' : 'cod_below_price';
  return out;
}
export const explanationKey = (e) => String(e || '').split(':')[0];

// ─── order_items arithmetic ─────────────────────────────────────────────────
/**
 * The order_items lines after the repair. items: [{ id, quantity, price_per_unit, total_price }]
 * (numbers or numeric strings). Returns { ok: true, items: [{ id, quantity, price_per_unit,
 * total_price }] (strings for numerics), qty } or { ok: false, why }.
 */
export function planItems(items, newCents, { newQty = null } = {}) {
  const lines = [...(items || [])].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  const ppu = (cents, qty) => centsToStr(Math.round(cents / Math.max(1, Number(qty) || 0)));
  if (!lines.length) return { ok: true, items: [], qty: newQty };
  if (lines.length === 1) {
    const l = lines[0];
    const qty = newQty ?? Number(l.quantity);
    return { ok: true, items: [{ id: l.id, quantity: qty, price_per_unit: ppu(newCents, qty), total_price: centsToStr(newCents) }], qty: newQty };
  }
  if (newQty) return { ok: false, why: 'a quantity change on a multi-line order' };
  const old = lines.map((l) => toCents(l.total_price));
  const sum = old.reduce((s, c) => s + c, 0);
  if (!(sum > 0)) return { ok: false, why: `${lines.length} order_items lines that sum to ${centsToStr(sum)} € — no proportion to scale` };
  const next = old.map((c) => Math.round((c * newCents) / sum));
  let big = 0;
  for (let i = 1; i < old.length; i++) if (old[i] > old[big]) big = i;
  next[big] += newCents - next.reduce((s, c) => s + c, 0);
  if (next.some((c) => c < 0)) return { ok: false, why: 'scaling would leave a line negative' };
  return {
    ok: true, qty: null,
    items: lines.map((l, i) => ({ id: l.id, quantity: Number(l.quantity), price_per_unit: ppu(next[i], l.quantity), total_price: centsToStr(next[i]) })),
  };
}

// ─── the (deferred) commission, mirrored for REPORTING only ─────────────────
/** Mirror of supabase/functions/api/index.ts packageBonusRate — never used to write anything. */
export function packageBonusRate(unitPrice) {
  if (unitPrice >= 35) return 3;
  if (unitPrice > 25) return 2;
  return 1;
}
/** Mirror of orderPackageBonus (0 unless paid). */
export function orderPackageBonus(status, price, quantity, items) {
  if (status !== 'paid') return 0;
  if (items?.length) return items.reduce((t, it) => t + packageBonusRate(Number(it.price_per_unit || 0)) * Number(it.quantity || 0), 0);
  const units = Number(quantity || 0) || 1;
  return packageBonusRate(Number(price || 0) / Math.max(1, units)) * units;
}

// ─── classification ─────────────────────────────────────────────────────────
/**
 * @param rows   loader rows: the order + its named parcel (see repair-cod-price.mjs loadRows)
 * @param items  Map order_id → [{ id, quantity, price_per_unit, total_price }]
 * @param accepted  owner-accepted double claims (parseAcceptedDuplicates().entries)
 * @returns {{ candidates, excluded, lines, units, counts }}
 */
export function classifyCodPrice({ rows, items = new Map(), payout = new Set(), hold = new Set(), accepted = [],
  runTag = 'dry-run', today = '' }) {
  const acceptedBy = new Map(accepted.map((e) => [e.tracking_id, e]));
  const candidates = [], excluded = [], lines = [], units = [];
  const counts = { mismatches: 0, candidates: 0, quantity_changes: 0 };
  const sorted = [...rows].sort((a, b) => String(a.display_id).localeCompare(String(b.display_id)));
  for (const r of sorted) {
    const cod = Number(r.cod_mkd);
    if (!(cod > 0)) continue;                                   // owner: not when COD is 0
    const priceCents = toCents(r.price ?? 0);
    if (priceCents > 0 && codFit(priceCents / 100, cod)) continue;   // exact, or +150 delivery
    counts.mismatches++;

    const its = items.get(r.id) || [];
    const [source, detail] = saleSourceOf(r);
    const holders = Array.isArray(r.holder_ids) ? r.holder_ids : [];
    const acc = holders.length > 1 ? acceptedBy.get(r.tracking_id) : null;
    const ownerAccepted = !!acc && acc.key === holdersKey(holders);
    const suspicion = linkSuspicion(r, r);
    const reasons = [];
    if (hold.has(r.display_id)) reasons.push(['held', 'held back with --hold']);
    if (isTestPhone(r.customer_phone)) reasons.push(['test_phone', 'a test number — its orders are deleted by repair-test-phones.mjs']);
    if (isSyntheticProductName(r.product_name) || detail === 'disposition') reasons.push(['disposition', 'a disposition (0 ден call-outcome) row holding a parcel — a ghost link, not a sale']);
    if (!(priceCents > 0)) reasons.push(['zero_price', 'price 0 — nothing to compare the COD with (ghost signature; for a human)']);
    if (r.reg_order_id !== r.id) reasons.push(['link_not_agreed', r.reg_order_id ? 'the register links this parcel to another order' : 'the register does not link this parcel to the order']);
    if (holders.length > 1) reasons.push(['double_held', `tracking id named by ${holders.join(', ')}${ownerAccepted ? ' (owner-accepted: both orders kept)' : ''}`]);
    if (suspicion) reasons.push(['suspect_link', suspicion]);
    if (!SALE_STATUSES.includes(r.status)) reasons.push(['not_a_sale_status', `status ${r.status}`]);
    if (payout.has(r.id)) reasons.push(['in_payout', 'in agent_payout_items (payouts are deferred)']);

    // explanation + the proposed after-state (also for exclusions: the owner sees what it would be)
    const single = its.length === 1 ? its[0] : null;
    const qty = single ? Number(single.quantity) : its.length === 0 ? (Number(r.quantity) || 1) : null;
    const unitCents = single
      ? (toCents(single.price_per_unit) > 0 ? toCents(single.price_per_unit) : Math.round(toCents(single.total_price) / Math.max(1, qty)))
      : its.length === 0 && qty ? Math.round(priceCents / qty) : null;
    const cpaCount = altercpaCount(r.cpa_count);
    const cpaMkd = altercpaMkd(r.cpa_price, r.cpa_currency);
    const ex = explainCod({ priceCents, cod, qty, unitCents, cpaCount, cpaMkd });
    const newCents = codToCents(cod);
    const plan = planItems(its, newCents, { newQty: ex.newQty });
    if (!reasons.length && !plan.ok) reasons.push(['items_unscalable', plan.why]);

    const newQty = ex.newQty;
    const bonusBefore = orderPackageBonus(r.status, priceCents / 100, r.quantity, its);
    const bonusAfter = plan.ok ? orderPackageBonus(r.status, newCents / 100, newQty ?? r.quantity, plan.items.length ? plan.items : null) : bonusBefore;
    const crmMkd = expectedCodMkd(priceCents / 100);
    const row = {
      decision: reasons.length ? 'excluded' : 'reprice',
      rule: reasons.length ? reasons[0][0] : (newQty ? 'reprice_qty' : 'reprice'),
      why: reasons.map(([k, w]) => `${k}: ${w}`).join(' | '),
      explained: ex.explained,
      order: r.display_id, status: r.status, source, detail, created: fmtSkopje(r.created_at),
      customer: r.customer_name, phone: r.customer_phone, city: r.customer_city,
      product: r.product_name, qty: r.quantity, items_n: its.length,
      items_sum_eur: its.length ? centsToStr(its.reduce((s, i) => s + toCents(i.total_price), 0)) : '',
      crm_eur: centsToStr(priceCents), crm_mkd: crmMkd, cod_mkd: cod, diff_mkd: cod - crmMkd,
      new_price_eur: centsToStr(newCents), new_qty: newQty ?? '',
      new_items: plan.ok ? plan.items.map((i) => `${i.quantity}×${i.price_per_unit}=${i.total_price}`).join(' + ') : '',
      tracking: r.tracking_id, account: r.account, series: r.series || '', parcel_status: `${r.status_id ?? ''} ${r.status_name || ''}`.trim(),
      parcel_created: fmtSkopje(r.created_at_mex), delivered_at: fmtSkopje(r.delivered_at), returned_at: fmtSkopje(r.returned_at),
      link_method: r.link_method || '', holders: holders.join(', '), owner_accepted: ownerAccepted ? 'yes' : '',
      altercpa_id: r.altercpa_id || '', altercpa_count: cpaCount ?? '', altercpa_mkd: cpaMkd ?? '', altercpa_fits: ex.cpaFits,
      paid: r.status === 'paid' ? 'yes' : '', bonus_now: bonusBefore, bonus_after: bonusAfter,
      in_payout: payout.has(r.id) ? 'yes' : '',
      order_cod_fact: r.mex_cod_mkd ?? '', paid_basis: r.paid_basis || '',
    };
    if (reasons.length) { excluded.push(row); counts[`x_${reasons[0][0]}`] = (counts[`x_${reasons[0][0]}`] || 0) + 1; continue; }

    counts.candidates++;
    if (newQty) counts.quantity_changes++;
    candidates.push(row);
    const target = `${centsToStr(newCents)}${newQty ? `x${newQty}` : ''}`;
    const line = planLine(r.id, row.rule, target, r.tracking_id);
    lines.push(line);
    const note = `Repair ${KEY} (run ${runTag}): MEX ${r.account || ''} parcel ${r.tracking_id} (${row.parcel_status}) carries COD ${fmtMkd(cod)} ден,` +
      ` the CRM price was ${fmtEur(priceCents)} (= ${fmtMkd(crmMkd)} ден at 61,5). Owner decision 28.09.2026: MEX is right — the price is now` +
      ` ${fmtEur(newCents)} (the COD / 61,5)` +
      (newQty ? `, quantity ${qty} → ${newQty} (AlterCPA's own record: ${cpaCount} packs × ${fmtEur(unitCents)} = the COD)` : '') +
      (its.length ? `; order_items kept consistent (Σ ${fmtEur(newCents)})` : '') +
      `. ${ex.explained ? `Why it differed: ${ex.explained.split(': ').slice(1).join(': ') || ex.explained}. ` : ''}` +
      `No stock movement is written; payout/commission math is unchanged (deferred)${today ? `; ${today}` : ''}.`;
    units.push({
      order_id: r.id, rule: row.rule, line,
      expect_status: r.status, expect_tracking: r.tracking_id, expect_price: centsToStr(priceCents), expect_price_raw: String(r.price),
      expect_quantity: r.quantity == null ? null : Number(r.quantity), expect_items_fp: r.items_fp ?? '', expect_cod: cod,
      new_price: centsToStr(newCents), new_quantity: newQty, new_items: plan.items,
      note,
      evidence: {
        key: KEY, order: r.display_id, tracking: r.tracking_id, account: r.account, series: r.series || null,
        parcel_status: r.status_id ?? null, cod_mkd: cod, price_before_eur: centsToStr(priceCents), price_after_eur: centsToStr(newCents),
        quantity_before: r.quantity ?? null, quantity_after: newQty ?? r.quantity ?? null,
        explained: ex.explained || null, altercpa_count: cpaCount, altercpa_mkd: cpaMkd, source, detail,
      },
    });
  }
  return { candidates, excluded, lines, units, counts };
}

// ─── SQL ────────────────────────────────────────────────────────────────────
/** md5 of an order's lines — the loader and the chunk compute it the SAME way. */
export const itemsFingerprintSql = (orderIdExpr) =>
  `(select md5(coalesce(string_agg(i.id::text || ':' || i.quantity::text || ':' || i.price_per_unit::text || ':' || i.total_price::text, '|' order by i.id), ''))
      from public.order_items i where i.order_id = ${orderIdExpr})`;

/** Before/after image of a re-priced order (data_repair_rows; rollback-repair.mjs restores it). */
export const priceSnapshotSql = (o) => `jsonb_build_object('kind', 'price', 'price', ${o}.price, 'quantity', ${o}.quantity,
    'status', ${o}.status::text, 'mex_tracking_id', ${o}.mex_tracking_id,
    'items', coalesce((select jsonb_agg(jsonb_build_object('id', i.id, 'quantity', i.quantity, 'price_per_unit', i.price_per_unit,
                                                          'total_price', i.total_price) order by i.id)
                         from public.order_items i where i.order_id = ${o}.id), '[]'::jsonb))`;
/** The part of the image a price rollback compares and restores. */
export const PRICE_KEYS = Object.freeze(['price', 'quantity', 'items']);

/**
 * ONE transaction per chunk (no explicit BEGIN/COMMIT — see the kit's buildChunkSql):
 * guards (bulk_repair + keep_updated_at) → lock orders, their lines, the parcels → keep only
 * orders still exactly as planned (status, parcel, price, quantity, lines fingerprint, the
 * parcel's link and COD) → data_repair_rows.before → price (+ quantity) → lines → verify
 * Σ lines = price → one order_notes row each → after. No order_history row: the status does
 * not change (and a history row would read as a sales decision in v_sales_work).
 */
export function buildPriceChunkSql({ runId, units }) {
  if (!units.length) throw new Error('empty chunk');
  if (units.length > MAX_CHUNK) throw new Error(`chunk of ${units.length} > ${MAX_CHUNK}`);
  const actor = `System (repair:${KEY})`;
  const values = units.map((u) => `(${[
    qUuid(u.order_id), q(u.rule), q(u.expect_status), q(u.expect_tracking), `${q(u.expect_price_raw ?? u.expect_price)}::numeric`,
    u.expect_quantity == null ? 'NULL::integer' : `${Number(u.expect_quantity)}::integer`, q(u.expect_items_fp), `${Number(u.expect_cod)}::integer`,
    `${q(u.new_price)}::numeric(10,2)`, u.new_quantity == null ? 'NULL::integer' : `${Number(u.new_quantity)}::integer`,
    qJson(u.new_items || []), q(u.note), qJson({ ...(u.evidence || {}), line: u.line }),
  ].join(', ')})`);
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _plan (
  order_id uuid primary key, rule text not null, expect_status text not null, expect_tracking text not null,
  expect_price numeric not null, expect_quantity integer, expect_items_fp text not null, expect_cod integer not null,
  new_price numeric(10,2) not null, new_quantity integer, new_items jsonb not null, note text not null, evidence jsonb not null
) on commit drop;
insert into _plan values
${values.join(',\n')};

select count(*) from (select 1 from public.orders where id in (select order_id from _plan) order by id for update) l;
select count(*) from (select 1 from public.order_items where order_id in (select order_id from _plan) order by id for update) l;
select count(*) from (select 1 from public.mex_parcels where tracking_id in (select expect_tracking from _plan) order by tracking_id for share) l;

-- only orders still exactly as the dry run saw them
create temp table _ok on commit drop as
select p.* from _plan p
  join public.orders o on o.id = p.order_id
  join public.mex_parcels mp on mp.tracking_id = p.expect_tracking
 where o.status::text = p.expect_status
   and o.mex_tracking_id = p.expect_tracking
   and o.price = p.expect_price
   and o.quantity is not distinct from p.expect_quantity
   and mp.order_id = o.id
   and mp.cod_mkd = p.expect_cod
   and ${itemsFingerprintSql('o.id')} = p.expect_items_fp
   and jsonb_array_length(p.new_items) = (select count(*) from public.order_items i where i.order_id = o.id);

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(runId)}, k.order_id, k.rule, ${priceSnapshotSql('o')}, k.evidence
  from _ok k join public.orders o on o.id = k.order_id;

update public.orders o
   set price = k.new_price,
       quantity = coalesce(k.new_quantity, o.quantity)
  from _ok k
 where o.id = k.order_id;

update public.order_items i
   set quantity = (x->>'quantity')::integer,
       price_per_unit = (x->>'price_per_unit')::numeric,
       total_price = (x->>'total_price')::numeric
  from _ok k cross join lateral jsonb_array_elements(k.new_items) x
 where i.order_id = k.order_id and i.id = (x->>'id')::uuid;

do $chk$
declare n int;
begin
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id where o.price is distinct from k.new_price;
  if n > 0 then raise exception 'repair: % order(s) did not take their new price', n; end if;
  select count(*) into n from _ok k
   where exists (select 1 from public.order_items i where i.order_id = k.order_id)
     and (select sum(i.total_price) from public.order_items i where i.order_id = k.order_id) is distinct from k.new_price;
  if n > 0 then raise exception 'repair: % order(s) whose order_items do not sum to the new price', n; end if;
  select count(*) into n from _ok k join public.orders o on o.id = k.order_id
   where k.new_quantity is not null and o.quantity is distinct from k.new_quantity;
  if n > 0 then raise exception 'repair: % order(s) did not take their new quantity', n; end if;
end $chk$;

insert into public.order_notes (order_id, text, author_id, author_name)
select k.order_id, k.note, null, ${q(actor)} from _ok k;

update public.data_repair_rows r set after = ${priceSnapshotSql('o')}
  from _ok k join public.orders o on o.id = k.order_id
 where r.run_id = ${qUuid(runId)} and r.order_id = k.order_id and r.after is null;

select (select count(*) from _plan)::int as planned,
       (select count(*) from _ok)::int as applied,
       (select coalesce(jsonb_agg(p.order_id), '[]'::jsonb) from _plan p
         where not exists (select 1 from _ok k where k.order_id = p.order_id)) as skipped;`;
}

/**
 * Undo a cod-price run (rollback-repair.mjs): an order goes back to its `before` price,
 * quantity and lines ONLY while price, quantity and lines still equal `after` (status and MEX
 * facts may have moved on — they are not what this repair changed). Recorded like every
 * rollback: data_repair_rows before/after under the rollback run, one order_notes row each.
 */
export function buildPriceRollbackSql({ key, runId, rbRunId, orderIds }) {
  const actor = `System (rollback:${key})`;
  const cmp = (snap) => `(${snap} - 'status' - 'mex_tracking_id')`;
  return `
set local elyon.bulk_repair = 'on';
set local elyon.keep_updated_at = 'on';
set local statement_timeout = '120s';
set local lock_timeout = '20s';
set local timezone = 'UTC';

create temp table _rb on commit drop as
select r.id as row_id, r.order_id, r.rule, r.before, r.after
  from public.data_repair_rows r
 where r.run_id = ${qUuid(runId)} and r.after is not null and r.after->>'kind' = 'price'
   and r.order_id = any(ARRAY[${orderIds.map(qUuid).join(',') || ''}]::uuid[]);

select count(*) from (select 1 from public.orders where id in (select order_id from _rb) order by id for update) l;
select count(*) from (select 1 from public.order_items where order_id in (select order_id from _rb) order by id for update) l;

create temp table _eq on commit drop as
select b.* from _rb b join public.orders o on o.id = b.order_id
 where ${cmp(priceSnapshotSql('o'))} = ${cmp('b.after')};

insert into public.data_repair_rows (run_id, order_id, rule, before, evidence)
select ${qUuid(rbRunId)}, e.order_id, 'rollback:' || e.rule, ${priceSnapshotSql('o')},
       jsonb_build_object('rolled_back_run', ${q(runId)}, 'line', e.order_id::text || ':rollback:' || coalesce(e.before->>'price', '') || ':')
  from _eq e join public.orders o on o.id = e.order_id;

update public.orders o
   set price = (e.before->>'price')::numeric, quantity = (e.before->>'quantity')::integer
  from _eq e where o.id = e.order_id;

update public.order_items i
   set quantity = (x->>'quantity')::integer,
       price_per_unit = (x->>'price_per_unit')::numeric,
       total_price = (x->>'total_price')::numeric
  from _eq e cross join lateral jsonb_array_elements(e.before->'items') x
 where i.order_id = e.order_id and i.id = (x->>'id')::uuid;

do $chk$
declare n int;
begin
  select count(*) into n from _eq e join public.orders o on o.id = e.order_id
   where ${cmp(priceSnapshotSql('o'))} is distinct from ${cmp('e.before')};
  if n > 0 then raise exception 'rollback: % order(s) did not return to their before-image', n; end if;
end $chk$;

insert into public.order_notes (order_id, text, author_id, author_name)
select e.order_id, ${q(`Rollback of repair ${key} (run ${String(runId).slice(0, 8)}): price, quantity and order_items are back to what they were before that repair.`)}, null, ${q(actor)}
  from _eq e;

update public.data_repair_rows r set after = ${priceSnapshotSql('o')}
  from _eq e join public.orders o on o.id = e.order_id
 where r.run_id = ${qUuid(rbRunId)} and r.order_id = e.order_id and r.after is null;

select (select count(*) from _rb)::int as candidates, (select count(*) from _eq)::int as restored, 0 as status_moves,
       (select coalesce(jsonb_agg(b.order_id), '[]'::jsonb) from _rb b
         where not exists (select 1 from _eq e where e.order_id = b.order_id)) as skipped;`;
}
