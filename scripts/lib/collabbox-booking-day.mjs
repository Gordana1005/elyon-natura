/**
 * collabBox BOOKING DAY — when did the operator book a document? (owner, 01.10.2026: "the day the
 * operator entered it counts; delivery five days later only validates it or makes it a return").
 *
 * collabBox's document date (`Datum` → collabbox_documents.doc_at) is the DISPATCH day: it keeps the
 * booking's clock time but carries the day the parcel is sent. A document booked on 30.09 at 10:30
 * for dispatch on 01.10 reads "01.10.2026 10:30". This module decides `booked_at` and its basis:
 *
 *   'seen'      the live sync saw the document appear: a full pass that had read its day (or the
 *               ahead range that holds it) started < 23 h before the pass that first saw it and did
 *               not find it, so it was booked in between. booked_at = the document's clock time on
 *               the latest day ≤ the sighting (exact even across midnight), when that instant is not
 *               before the watching pass (30 min tolerance: the clock is when the operator OPENED the
 *               document, it is saved a little later); otherwise LEAST(doc_at, first_seen_at).
 *   'sequence'  DocNumbers are allocated in booking order per series (002-9102-177909/2026 at 30.09
 *               10:08 < 177916 dated 01.10 10:30 < 177920 at 30.09 11:19 → 177916 was booked on 30.09).
 *               Upper bound = the 3rd smallest LEAST(doc_at, first_seen_at) among the next 20 numbers
 *               of the same series (robust to the rare document dated a day BACK, seen on 9110), and the
 *               document's own first sighting; booked_at = its clock time on the latest day ≤ that
 *               bound + 60 min (numbers and clock times disagree by ≤ 10 min).
 *   'doc'       nothing better: booked_at = doc_at.
 *   Never later than doc_at; never more than MAX_BACK_DAYS before it (an estimate further back is
 *   distrusted → 'doc').
 *
 * TWIN of public.collabbox_estimate_booked_at() in
 * supabase/migrations/20260944000500_collabbox_booked_at.sql — the constants are checked by
 * supabase/functions/collabbox-sync/bookingDay.test.ts; the dry run of
 * scripts/backfill-collabbox-booked-at.mjs compares both on live data once the migration is applied.
 * Pure: no database, no network. Times are epoch SECONDS.
 */

export const SEQ_NEXT = 20;            // later numbers of the same series that are looked at
export const SEQ_RANK = 3;             // the 3rd smallest of them is the bound (a dated-back outlier is ignored)
export const SEQ_TOL_S = 60 * 60;      // numbers vs clock times: ≤ 10 min apart measured; 60 min allowed
export const WATCH_MAX_S = 23 * 3600;  // a watching pass must have started < 23 h before the sighting
export const SEEN_TOL_S = 30 * 60;     // open-vs-save: the clock may be a little before the watching pass
export const MAX_BACK_DAYS = 31;       // never trust an estimate further back than this
export const TZ = 'Europe/Skopje';

const DOC_RE = /^([0-9]{3})-([0-9]{4})-([0-9]{1,15})\/([0-9]{4})$/;
/** '002-9102-177916/2026' → { key: '002-9102/2026', no: 177916 } (null for any other shape). */
export function seqOf(docNumber) {
  const m = DOC_RE.exec(String(docNumber ?? '').trim());
  return m ? { key: `${m[1]}-${m[2]}/${m[4]}`, no: Number(m[3]) } : null;
}

const PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});
/** epoch seconds → { ymd: 'YYYY-MM-DD', clock: seconds since local midnight } in Skopje. */
export function skopjeParts(sec) {
  const p = Object.fromEntries(PARTS.formatToParts(new Date(sec * 1000)).map((x) => [x.type, x.value]));
  return { ymd: `${p.year}-${p.month}-${p.day}`, clock: Number(p.hour) * 3600 + Number(p.minute) * 60 + Number(p.second) };
}
export const skopjeDay = (sec) => skopjeParts(sec).ymd;

/** The Skopje wall clock `clock` on local day `ymd` → epoch seconds (DST-exact; a skipped hour → the next valid instant). */
export function skopjeInstant(ymd, clock) {
  const base = Date.parse(`${ymd}T00:00:00Z`) / 1000 + clock;
  for (const off of [1, 2, 0, 3]) {               // Skopje is UTC+1 / UTC+2; an hour that occurs twice
                                                   // (autumn) is read as CET, the later one — as Postgres does
    const t = base - off * 3600;
    const p = skopjeParts(t);
    if (p.ymd === ymd && p.clock === clock) return t;
  }
  return base - 3600;                              // inside the spring-forward gap: take CET
}
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/** The latest instant ≤ `bound` whose Skopje clock equals the clock of `like` (both epoch seconds). */
export function projectClockBelow(like, bound) {
  const { clock } = skopjeParts(like);
  const day = skopjeParts(bound).ymd;
  for (let back = 0; back <= 2; back++) {
    const t = skopjeInstant(addDays(day, -back), clock);
    if (t <= bound) return t;
  }
  return null;
}

/**
 * 'seen': the latest watching pass for the document's day that FINISHED before the sighting (so it
 * read the day and did not find the document — never the pass that saw it).
 * runs: [{ id, kind, started, finished, status, from, to, ahead_to }] (epoch seconds; days YYYY-MM-DD). A pass
 * watches day D when it finished 'ok' and D ∈ [from, to], or D ∈ (to, ahead_to] (the ahead range it read).
 * firstRunId — the pass that first saw the document (collabbox_documents.first_run_id) never counts.
 */
export function watchingStart(day, seenAt, runs, firstRunId = null) {
  let best = null;
  for (const r of runs) {
    if (r.status !== 'ok' || (r.kind != null && r.kind !== 'manual' && r.kind !== 'nightly')) continue;   // a full pass
    if (r.finished == null || r.finished >= seenAt || r.started < seenAt - WATCH_MAX_S) continue;
    if (firstRunId != null && r.id === firstRunId) continue;
    const inWindow = r.from <= day && day <= r.to;
    const inAhead = r.ahead_to != null && r.to < day && day <= r.ahead_to;
    if ((inWindow || inAhead) && (best == null || r.started > best)) best = r.started;
  }
  return best;
}

/**
 * The booking time of ONE document. doc: { doc_number, doc_at, first_seen_at, first_run_id } (epoch seconds);
 * later: LEAST(doc_at, first_seen_at) of the next SEQ_NEXT documents of its series by number
 * (ascending number; any type, vanished or not — the counter is the series'); runs: see watchingStart.
 * → { booked_at, basis }.
 */
export function estimateBookedAt(doc, later, runs) {
  const docAt = doc.doc_at;
  const seen = doc.first_seen_at;
  const keep = (t, basis) => (t == null || t >= docAt || docAt - t > MAX_BACK_DAYS * 86400)
    ? { booked_at: docAt, basis: 'doc' } : { booked_at: t, basis };
  const w = seen != null ? watchingStart(skopjeDay(docAt), seen, runs ?? [], doc.first_run_id ?? null) : null;
  if (w != null) {
    const p = projectClockBelow(docAt, seen);
    const t = p != null && p >= w - SEEN_TOL_S ? p : Math.min(docAt, seen);
    return t >= docAt ? { booked_at: docAt, basis: 'seen' } : keep(t, 'seen');
  }
  const vals = (later ?? []).slice(0, SEQ_NEXT).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let bound = vals.length >= SEQ_RANK ? vals[SEQ_RANK - 1] : null;
  if (seen != null) bound = bound == null ? seen : Math.min(bound, seen);
  if (bound == null || bound + SEQ_TOL_S >= docAt) return { booked_at: docAt, basis: 'doc' };
  return keep(projectClockBelow(docAt, bound + SEQ_TOL_S), 'sequence');
}

/**
 * Every document of a ledger at once (the backfill's dry run). docs: [{ doc_number, doc_at,
 * first_seen_at, … }] — any order; runs as above. Returns Map doc_number → { booked_at, basis }.
 */
export function estimateAll(docs, runs) {
  const bySeries = new Map();
  const out = new Map();
  for (const d of docs) {
    const s = seqOf(d.doc_number);
    if (!s) { out.set(d.doc_number, estimateBookedAt(d, [], runs)); continue; }
    (bySeries.get(s.key) ?? bySeries.set(s.key, []).get(s.key)).push({ d, no: s.no });
  }
  for (const arr of bySeries.values()) {
    arr.sort((a, b) => a.no - b.no || String(a.d.doc_number).localeCompare(String(b.d.doc_number)));
    for (let i = 0; i < arr.length; i++) {
      const later = [];
      for (let j = i + 1; j < arr.length && later.length < SEQ_NEXT; j++) {
        if (arr[j].no === arr[i].no) continue;
        const x = arr[j].d;
        later.push(x.first_seen_at == null ? x.doc_at : Math.min(x.doc_at, x.first_seen_at));
      }
      out.set(arr[i].d.doc_number, estimateBookedAt(arr[i].d, later, runs));
    }
  }
  return out;
}

/** The closed-month rule (owner's call, default 01.10.2026): the sale moves to the booking day only
 *  when the booking day is on/after `since` (epoch seconds of Skopje midnight). TWIN of
 *  public.collabbox_sale_at(). */
export function saleAt(docAt, bookedAt, since) {
  return bookedAt != null && bookedAt < docAt && bookedAt >= since ? bookedAt : docAt;
}
