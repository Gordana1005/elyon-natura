import type { TFunction } from 'i18next';
import type { PackRow, PushWarning } from '@/lib/warehouseApi';

// Pure text helpers for /warehouse (plan Фаза 9) — every date is a Skopje day
// written dd.MM.yyyy, every machine note the server writes in English is said
// in the reader's language when it is a known one.

const SKOPJE_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', year: 'numeric', month: '2-digit', day: '2-digit' });
const SKOPJE_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Skopje', hour: '2-digit', minute: '2-digit', hour12: false });

const valid = (v: string | number | Date | null | undefined): Date | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** dd.MM.yyyy on the Skopje calendar ('—' when empty). */
export function skopjeDate(v: string | number | Date | null | undefined): string {
  const d = valid(v);
  if (!d) return '—';
  const [dd, mm, yyyy] = SKOPJE_DAY.format(d).split('/');
  return `${dd}.${mm}.${yyyy}`;
}

/** dd.MM.yyyy HH:mm on the Skopje clock. */
export function skopjeDateTime(v: string | number | Date | null | undefined): string {
  const d = valid(v);
  return d ? `${skopjeDate(d)} ${SKOPJE_TIME.format(d)}` : '—';
}

/** YYYY-MM-DD of the Skopje day — the grouping key. */
export function skopjeYmd(v: string | number | Date | null | undefined): string | null {
  const d = valid(v);
  if (!d) return null;
  const [dd, mm, yyyy] = SKOPJE_DAY.format(d).split('/');
  return `${yyyy}-${mm}-${dd}`;
}

/** Whole Skopje days between two moments (0 = the same day). */
export function daysBetween(from: string | number | Date | null | undefined, now: Date = new Date()): number | null {
  const a = skopjeYmd(from);
  const b = skopjeYmd(now);
  if (!a || !b) return null;
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The MEX account's own name, as the portal writes it. */
export const accountName = (a: string | null | undefined) => (a === 'bio_natural' ? 'BIO NATURAL' : a === 'natura' ? 'NATURA' : '—');

/** Parcels at MEX 8 grouped by the Skopje day they were created, in the order they came. */
export function groupByDay(rows: PackRow[]): Array<{ day: string | null; rows: PackRow[] }> {
  const out: Array<{ day: string | null; rows: PackRow[] }> = [];
  for (const r of rows) {
    const day = skopjeYmd(r.created_at);
    const last = out[out.length - 1];
    if (last && last.day === day) last.rows.push(r);
    else out.push({ day, rows: [r] });
  }
  return out;
}

/** Every code with words under warehousePage.code.* (the push's validation / refusal codes). */
export const KNOWN_CODES = new Set([
  'name', 'phone', 'postal_code', 'product', 'price', 'address', 'house_number', 'office', 'mex_city',
  'not_confirmed', 'has_parcel', 'already_sent', 'web_order', 'test_phone', 'ship_later', 'no_reference',
  'needs_pick', 'bad_override', 'double_parcel_risk', 'account_disabled', 'account_not_configured',
  'csv_parcel_exists', 'existence_check_failed', 'mex_key_rejected', 'mex_refused', 'unknown_outcome',
  'created_not_saved', 'claimed_recently', 'claim_failed', 'not_found', 'time_budget', 'not_configured',
  'link_conflict', 'record_failed', 'exists_in_register',
]);

/** Validation / refusal codes the push uses → words ("mex_refused: …" keeps only its code). Unknown codes are shown as they are. */
export function codeText(t: TFunction, code: string, ctx: Record<string, unknown> = {}): string {
  const base = code.split(':')[0].trim();
  const norm = base.startsWith('link_') && base !== 'link_conflict' ? 'link_conflict' : base;
  return KNOWN_CODES.has(norm) ? t(`warehousePage.code.${norm}`, ctx) : code;
}

/** One warning line. */
export function warningText(t: TFunction, w: PushWarning): string {
  switch (w.code) {
    case 'unlinked_parcel': return t('warehousePage.warn.unlinkedParcel', { tracking: w.tracking_id, account: accountName(w.account) });
    case 'collabbox_doc': return t('warehousePage.warn.collabboxDoc', { doc: w.doc_number, date: skopjeDate(w.doc_at) });
    case 'other_parcel': return t('warehousePage.warn.otherParcel', { tracking: w.tracking_id, order: w.order_display_id ?? '—' });
    case 'sent_unconfirmed': return t('warehousePage.warn.sentUnconfirmed', { date: skopjeDateTime(w.mex_sent_at) });
    case 'last_attempt_failed': return t('warehousePage.warn.lastAttemptFailed', { error: codeText(t, String(w.error ?? '')) });
    default: return String((w as { code?: string }).code ?? '');
  }
}

/**
 * A stock movement's note in the reader's language when the server wrote a known
 * machine text; anything a person typed is shown as it is.
 */
export function movementNote(t: TFunction, notes: string | null | undefined): string {
  const n = String(notes ?? '').trim();
  if (!n) return '—';
  let m = n.match(/^complete-catalogue run [0-9a-f-]+: залиха-placeholder (\d+)/i);
  if (m) return t('warehousePage.movements.note.placeholder', { n: m[1] });
  m = n.match(/^Bulk stock set to (\d+) packages?\s*[—-]\s*(\d{4}-\d{2}-\d{2})/i);
  if (m) return t('warehousePage.movements.note.bulkSet', { n: m[1], date: skopjeDate(`${m[2]}T12:00:00Z`) });
  m = n.match(/^Bulk shipped\s*[—-]\s*(.+)$/i);
  if (m) return t('warehousePage.movements.note.bulkShipped', { product: m[1] });
  m = n.match(/^Order (ORD-\d+) shipped \(warehouse\)(?:\s*[—-]\s*(.+))?$/i);
  if (m) return m[2]
    ? t('warehousePage.movements.note.orderShippedProduct', { id: m[1], product: m[2] })
    : t('warehousePage.movements.note.orderShipped', { id: m[1] });
  return n;
}
