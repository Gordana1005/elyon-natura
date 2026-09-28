/**
 * Owner-accepted double claims — the data behind the C8a exception (verify-attribution.mjs).
 *
 * Owner decision 28.09.2026 (HANDOFF §3, law): "Duplicates: keep both orders on the 3 parcels
 * held by two orders (they may be identical but both are accurate). Add a checker C8a
 * exception."
 *
 * The accepted pairs live in ONE committed file, scripts/data/c8a-accepted-duplicates.json:
 *   { "accepted": [ { "tracking_id": "002-9110-158456/2026",
 *                     "orders": ["ORD-12345", "ORD-12399"],
 *                     "reason": "…why both orders are real…",
 *                     "owner_date": "2026-09-28" } ] }
 * An entry accepts EXACTLY that tracking id held by EXACTLY that set of orders. Any other
 * double claim — a new tracking id, or a third order joining an accepted one — still FAILs.
 * An entry whose tracking id is no longer double-claimed is STALE (WARN: clean the file).
 *
 * Pure except loadAcceptedDuplicates (one file read). No network, no database.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ACCEPTED_DUPLICATES_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'c8a-accepted-duplicates.json');

const DISPLAY_RE = /^ORD-\d+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const normId = (s) => String(s ?? '').trim().toUpperCase();
/** Order-independent key of a set of display ids. */
export const holdersKey = (ids) => [...new Set([...ids].map(normId))].sort().join('|');

/**
 * Validate the parsed JSON document. Returns { entries, errors } — a non-empty `errors`
 * means the file must not be trusted (the checker FAILs C8a rather than accept anything).
 */
export function parseAcceptedDuplicates(doc) {
  const errors = [];
  const list = doc && Array.isArray(doc.accepted) ? doc.accepted : null;
  if (!list) return { entries: [], errors: ['the file has no "accepted" array'] };
  const entries = [];
  const seen = new Set();
  list.forEach((e, i) => {
    const at = `accepted[${i}]`;
    const tracking = String(e?.tracking_id ?? '').trim();
    const orders = Array.isArray(e?.orders) ? [...new Set(e.orders.map(normId))] : [];
    if (!tracking) errors.push(`${at}: tracking_id is empty`);
    if (orders.length < 2) errors.push(`${at}: "orders" must list the (at least two) display ids that hold ${tracking || 'the parcel'}`);
    const bad = orders.filter((d) => !DISPLAY_RE.test(d));
    if (bad.length) errors.push(`${at}: not a display id: ${bad.join(', ')}`);
    if (!String(e?.reason ?? '').trim()) errors.push(`${at}: reason is empty — say why both orders are real`);
    if (!DATE_RE.test(String(e?.owner_date ?? ''))) errors.push(`${at}: owner_date must be YYYY-MM-DD (the day the owner accepted it)`);
    if (tracking && seen.has(tracking)) errors.push(`${at}: tracking_id ${tracking} is listed twice`);
    seen.add(tracking);
    entries.push({ tracking_id: tracking, orders: orders.sort(), key: holdersKey(orders), reason: String(e?.reason ?? '').trim(), owner_date: String(e?.owner_date ?? '') });
  });
  return { entries, errors };
}

/** Read + validate the committed file. A missing file = no exceptions (and says so). */
export function loadAcceptedDuplicates(file = ACCEPTED_DUPLICATES_FILE) {
  let text;
  try { text = readFileSync(file, 'utf8'); } catch (e) {
    return { entries: [], errors: [], missing: true, file };
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) {
    return { entries: [], errors: [`not valid JSON: ${String(e.message || e).slice(0, 200)}`], missing: false, file };
  }
  return { ...parseAcceptedDuplicates(doc), missing: false, file };
}

/**
 * Split the CURRENT double claims into accepted / unaccepted, and the file's entries into
 * matched / stale / changed.
 *   doubles: [{ tracking_id, holders: [{ display_id, … }] }]  (≥ 2 holders each)
 * @returns {{ accepted, unaccepted, stale, changed }}
 *   accepted    doubles whose (tracking id, holder set) is exactly an entry
 *   unaccepted  every other double (these FAIL)
 *   stale       entries whose tracking id is no longer held by two orders (WARN)
 *   changed     entries whose tracking id IS double-claimed, but by another set of orders
 *               (that double is in `unaccepted` too)
 */
export function classifyDoubleClaims(doubles, entries) {
  const byTracking = new Map(entries.map((e) => [e.tracking_id, e]));
  const accepted = [], unaccepted = [], changed = [];
  const current = new Set();
  for (const d of doubles) {
    current.add(d.tracking_id);
    const e = byTracking.get(d.tracking_id);
    const key = holdersKey((d.holders || []).map((h) => h.display_id));
    if (e && e.key === key) accepted.push({ ...d, reason: e.reason, owner_date: e.owner_date });
    else {
      unaccepted.push(d);
      if (e) changed.push({ ...e, now_held_by: key.split('|') });
    }
  }
  const stale = entries.filter((e) => !current.has(e.tracking_id));
  return { accepted, unaccepted, stale, changed };
}

/** The read-only SQL that lists today's double claims — what the file's entries are taken from. */
export const DOUBLE_CLAIMS_SQL = `select o.mex_tracking_id as tracking_id,
       jsonb_agg(o.display_id order by o.display_id) as orders,
       string_agg(o.display_id || ' ' || o.status::text || ' ' || coalesce(o.sale_source, o.source_type, '-')
                  || ' ' || to_char(o.created_at at time zone 'Europe/Skopje', 'DD.MM.YYYY')
                  || ' EUR ' || coalesce(o.price, 0)::text, ' | ' order by o.display_id) as detail
  from public.orders o
 where o.mex_tracking_id is not null and o.status::text <> 'duplicated'
 group by o.mex_tracking_id
having count(*) > 1
 order by o.mex_tracking_id`;
