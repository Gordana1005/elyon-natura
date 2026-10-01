/**
 * link-manual-approved — the pure half of scripts/repair-link-manual-approved.mjs (owner, Mile, 01.10.2026). No I/O here.
 *
 * The nightly phone + date linker (public.link_lead_parcels_plan, 20260944000950) leaves a parcel with more than one
 * candidate order on its manual list. A read-only reviewer proposed one pick per parcel of that list
 * (exports/MEX_рачна_проверка_предлог_2026-10-01.xlsx, sheet "Рачна проверка": "ПОВРЗИ со ORD-…" / "НЕ ПОВРЗУВАЈ" /
 * "ЗА ГАЗДАТА"); the owner approved linking EVERY "ПОВРЗИ" row (32 parcels: 19 high + 13 medium confidence).
 *
 * Each approved pair is re-validated LIVE and linked with the SAME apply semantics as public.link_lead_parcels():
 * mex_link_parcel(…, 'repair'), the order follows MEX (2 → paid, paid_basis 'mex' — an order already paid only gains
 * the basis · 7 → returned · 8 → unchanged · else → shipped), the disposition fields cleared, order_history + one
 * note, ledger rows before / after in the repair-kit snapshot shape (undo: scripts/rollback-repair.mjs --run <id>).
 * The write itself is the repair-kit's applyUnits (the engine scripts/repair-link-elyon-parcels.mjs uses) — nothing
 * here writes SQL that changes rows.
 */
import { planLine, mexStatusSet, phone8, isSyntheticProductName, fmtSkopje, fmtMkd, toMs, DAY_MS } from './repair-kit.mjs';

export const KEY = 'link-manual-approved';
export const SOURCE_XLSX = 'exports/MEX_рачна_проверка_предлог_2026-10-01.xlsx';
export const SHEET = 'Рачна проверка';
/** The owner's approval of 01.10.2026: every "ПОВРЗИ" row of the reviewer's list (19 high + 13 medium). */
export const EXPECTED = Object.freeze({ approved: 32, link: 32 });
export const NOTE_TAG = 'linked by owner-approved manual review 01.10.2026';

/** The candidate statuses of the phone + date rule (rule 2) — never take / delivered / duplicated. */
export const CANDIDATE_STATUSES = Object.freeze(['pending', 'call_again', 'confirmed', 'paid', 'shipped', 'returned', 'cancelled', 'trashed']);

const PROPOSAL_RE = /^\s*ПОВРЗИ\s+со\s+(ORD-\d+)\s*$/u;
const TRACKING_RE = /^\d{3}-\d{4}-\d{5,7}\/\d{4}$/;

/** A cell of the reviewer's sheet → trimmed text. */
const cell = (v) => String(v ?? '').trim();

/**
 * The reviewer's rows (sheet_to_json objects, or CSV objects with the same headers / the derived columns
 * tracking, order, confidence) → { approved[], other{}, bad[] }. Only "ПОВРЗИ со ORD-n" rows are approved.
 */
export function parseApprovedRows(rows) {
  const approved = [], bad = [];
  const other = {};
  for (const r of rows ?? []) {
    const tracking = cell(r['MEX пратка'] ?? r.tracking);
    const proposal = cell(r['предлог'] ?? (r.order ? `ПОВРЗИ со ${cell(r.order)}` : ''));
    const n = cell(r['#'] ?? r.n);
    if (!tracking && !proposal) continue;
    const m = proposal.match(PROPOSAL_RE);
    if (!m) { other[proposal || '(empty)'] = (other[proposal || '(empty)'] || 0) + 1; continue; }
    if (!TRACKING_RE.test(tracking)) { bad.push({ n, tracking, proposal, why: 'not a MEX tracking id' }); continue; }
    approved.push({ n, tracking, display_id: m[1], confidence: cell(r['сигурност'] ?? r.confidence) });
  }
  return { approved, other, bad };
}

/** Pairs that share an order or a parcel with another approved pair — neither is linked (the owner decides). */
export function sharedPairs(approved) {
  const byOrder = new Map(), byParcel = new Map();
  for (const a of approved) {
    byOrder.set(a.display_id, (byOrder.get(a.display_id) || 0) + 1);
    byParcel.set(a.tracking, (byParcel.get(a.tracking) || 0) + 1);
  }
  const out = new Map();
  for (const a of approved) {
    if (byOrder.get(a.display_id) > 1) out.set(a.tracking, `${a.display_id} is approved for ${byOrder.get(a.display_id)} parcels`);
    else if (byParcel.get(a.tracking) > 1) out.set(a.tracking, `${a.tracking} is approved ${byParcel.get(a.tracking)} times`);
  }
  return out;
}

/**
 * The status the order takes from its parcel — EXACTLY link_lead_parcels_plan's `lk.target`: 2 → paid ('basis' for
 * an order already paid without basis mex, nothing when it is), 7 → returned, 8 (за пакување) → nothing, else →
 * shipped (nothing when already shipped).
 */
export function linkTarget(status, paidBasis, parcelStatusId) {
  const s = Number(parcelStatusId);
  if (s === 2) return status === 'paid' ? (paidBasis === 'mex' ? null : 'basis') : 'paid';
  if (s === 7) return status === 'returned' ? null : 'returned';
  if (s === 8) return null;
  return status === 'shipped' ? null : 'shipped';
}

const RULE1_SERIES = new Set(['9110', '9103']);

/**
 * Re-validate one approved pair against the LIVE rows. `p` = the parcel row (mex_parcels + named_by: how many orders
 * name it), `o` = the order row (+ held: register rows that point at it, phone8), `ctx` = { payout:Set, affiliate:Set,
 * excludedPhones:Set, shared:Map }. → null when it may be linked, else the reason it is skipped.
 */
export function validatePair(a, p, o, ctx) {
  if (ctx.shared?.has(a.tracking)) return ctx.shared.get(a.tracking);
  if (!p) return 'the parcel is not in the MEX register';
  if (p.order_id) return `the parcel is already linked (to ${p.order_display ?? p.order_id})`;
  if (Number(p.named_by) > 0) return `an order already names the parcel (${p.named_display ?? '?'})`;
  if (!(RULE1_SERIES.has(String(p.series ?? '')) || (!p.series && p.account === 'bio_natural'))) return `series ${p.series ?? '—'} is not a BIO NATURAL lead parcel`;
  if (!(Number(p.cod_mkd) > 0)) return 'the parcel has no COD';
  if (!/^\d{8}$/.test(String(p.phone8 ?? ''))) return 'the parcel has no valid phone';
  if (ctx.excludedPhones?.has(p.phone8)) return 'a test phone';
  if (!o) return `${a.display_id} does not exist`;
  if (o.mex_tracking_id) return `${a.display_id} already holds parcel ${o.mex_tracking_id}`;
  if (Number(o.held) > 0) return `${a.display_id} already holds a parcel in the register`;
  if (!CANDIDATE_STATUSES.includes(o.status)) return `${a.display_id} is ${o.status}`;
  if (phone8(o.customer_phone) !== p.phone8) return `${a.display_id} is on another phone (${phone8(o.customer_phone) || '—'} ≠ ${p.phone8})`;
  const pMs = toMs(p.created_at_mex), oMs = toMs(o.created_at);
  if (!(oMs >= pMs - 10 * DAY_MS && oMs <= pMs + DAY_MS)) return `${a.display_id} was created outside parcel −10 d … +1 d`;
  if (!(Number(o.price) > 0) || isSyntheticProductName(o.product_name) || o.sale_source_detail === 'disposition') return `${a.display_id} is not a priced real sale`;
  if (ctx.payout?.has(o.id)) return `${a.display_id} is in agent_payout_items`;
  if (ctx.affiliate?.has(o.id)) return `${a.display_id} is an affiliate lead (a status change sends a partner postback)`;
  if (Number(p.status_id) === 8 && o.status === 'confirmed') {
    return 'MEX 8 (за пакување) on a confirmed order: the repair-kit never leaves an order in confirmed — link it at the pickup';
  }
  return null;
}

export const hoursApart = (p, o) => Math.round(((toMs(p.created_at_mex) - toMs(o.created_at)) / 3_600_000) * 10) / 10;

/**
 * The approved pairs → repair-kit units (one order, one parcel each), the CSV, the plan lines the hash covers, the
 * status changes for the sticky-Trash pre-check, and the counts. `parcels` / `orders` = Maps by tracking / display id.
 */
export function classifyApproved({ approved, parcels, orders, ctx, runId = null }) {
  const runTag = runId ? String(runId).slice(0, 8) : 'dry-run';
  const shared = sharedPairs(approved);
  const units = [], csv = [], lines = [], changes = new Map();
  const counts = { approved: approved.length, link: 0, skipped: 0, high: 0, medium: 0 };
  for (const a of approved) {
    const p = parcels.get(a.tracking) ?? null;
    const o = orders.get(a.display_id) ?? null;
    const why = validatePair(a, p, o, { ...ctx, shared });
    const pTxt = p ? `${p.status_id ?? '?'} ${p.status_name ?? ''}`.trim() : '';
    const row = { n: a.n, tracking: a.tracking, order: a.display_id, confidence: a.confidence, mex_status: pTxt,
      cod_mkd: p?.cod_mkd ?? '', parcel_created: p ? fmtSkopje(p.created_at_mex) : '', order_status: o?.status ?? '',
      order_created: o ? fmtSkopje(o.created_at) : '', hours: p && o ? hoursApart(p, o) : '', source: o?.sale_source ?? '',
      product: o?.product_name ?? '', target: '', action: why ? 'skip' : 'link', why: why ?? '' };
    if (why) { counts.skipped++; csv.push(row); continue; }
    const target = linkTarget(o.status, o.paid_basis, p.status_id);
    row.target = target ?? (Number(p.status_id) === 8 ? '(unchanged, MEX 8)' : '(unchanged)');
    csv.push(row);
    counts.link++;
    if (/висока/i.test(a.confidence)) counts.high++; else if (/средна/i.test(a.confidence)) counts.medium++;
    const line = planLine(o.id, 'LM_manual', `${o.status}>${target ?? '='}`, a.tracking);
    lines.push(line);
    if (target && target !== 'basis') changes.set(o.id, { status: target });
    const set = target === 'basis' ? { paid_basis: 'mex' } : target ? mexStatusSet(target, p) : {};
    const move = target === 'basis' ? 'the order was already paid; MEX now proves it (paid basis mex).'
      : target ? `the status follows MEX: ${o.status} → ${target}.`
        : Number(p.status_id) === 8 ? 'the parcel is at MEX 8 (за пакување): the status waits for the courier\'s pickup.'
          : `the status (${o.status}) already matches MEX.`;
    units.push({
      unit: `lm:${a.tracking}`,
      rows: [{
        unit: `lm:${a.tracking}`, order_id: o.id, rule: 'LM_manual', line,
        expect_status: o.status, expect_tracking: null, set,
        link: { tracking: a.tracking, method: 'repair', force: false, expectOwner: null }, unlink: null,
        history: target && target !== 'basis' ? { from: o.status, to: target } : null,
        note: `MEX parcel ${a.tracking} (${p.account ?? '?'}, ${pTxt}, COD ${fmtMkd(p.cod_mkd)} ден, created ${fmtSkopje(p.created_at_mex)}) ` +
          `${NOTE_TAG}: the nightly phone + date rule listed it with more than one candidate order on this customer's phone; ` +
          `the reviewer proposed this order (confidence: ${a.confidence || '—'}, list row ${a.n}) and the owner approved it. ` +
          `This order created ${fmtSkopje(o.created_at)}, ${hoursApart(p, o)} h before the parcel; ${move} Nothing was sent to AlterCPA. ` +
          `Run ${runTag} (undo: scripts/rollback-repair.mjs --run ${runId ?? '<run id>'}).`,
        evidence: { key: KEY, order: a.display_id, tracking: a.tracking, row: a.n, confidence: a.confidence, target,
          parcel_status: p.status_id, cod_mkd: p.cod_mkd, hours: hoursApart(p, o), source: SOURCE_XLSX },
      }],
    });
  }
  return { units, csv, lines, changes, counts };
}

/** "cancelled → paid: 9 (27.000 ден)" — one row per move of the links. */
export function moveRows(csv) {
  const out = {};
  for (const r of csv.filter((x) => x.action === 'link')) {
    const k = `${r.order_status} → ${r.target}`;
    out[k] ??= { parcels: 0, mkd: 0 };
    out[k].parcels++;
    out[k].mkd += Number(r.cod_mkd) || 0;
  }
  return Object.entries(out).sort((a, b) => b[1].parcels - a[1].parcels)
    .map(([move, v]) => ({ move, parcels: v.parcels, 'COD (ден)': fmtMkd(v.mkd) }));
}
