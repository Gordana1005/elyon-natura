import { formatMoney } from '@/lib/currency';

// Prediction segment lists are named by the engine from its config — e.g.
// "57d ≤26 (3+ orders)" / "57d 26+ (3+ orders)", where the value-band token is
// a threshold in stored EUR (segment_engine_config.value_bands, max_price 26 €).
//
// ⚠️ DISPLAY ONLY. The engine resolves its target list by EXACT name and deletes
// memberships before resolving, so a renamed list silently loses its members
// (CLAUDE.md "Engine regression check"). Never write this label back, never use
// it as a key, a filter value or a lookup — only as text on screen.
//
// Only the strict "<recency> ≤N (…)" / "<recency> N+ (…)" shape is rewritten;
// anything else (NEWCOMERS, uploaded campaign lists, hand-made names) is shown
// exactly as stored.
const BANDED = /^(\S+) (≤)?(\d+(?:\.\d+)?)(\+)? (\(.+\))$/;

/** A list name taken apart for DISPLAY and grouping (Insights → Prediction
 *  lists): never a key, never written back — the same rule as the label. */
export interface ParsedListName {
  /** band = "<recency> ≤N|N+ (<orders> orders)" · newcomers = "NEWCOMERS (<orders> orders)"
   *  · pen = a named holding pen · other = anything else (shown as stored). */
  kind: 'band' | 'newcomers' | 'pen' | 'other';
  /** 21d | 57d | 4-6m | 6-12m | 1-2yr | 2yr+ (as named) · NEWCOMERS for newcomers. */
  recency: string | null;
  /** le = "≤N" (the lower value band), gt = "N+". */
  band: 'le' | 'gt' | null;
  /** The band threshold as stored (EUR) — show it with formatMoney(). */
  threshold: number | null;
  /** The frequency token as named: 1-3 | 3+ | 5+ | 7+. */
  orders: string | null;
  pen: PenKey | null;
}

/** The engine's named holding pens and statics (exact names, 2026-09-28). */
export const PREDICTION_PENS = {
  'Current Cancels': 'current_cancels',
  'Current Returns': 'current_returns',
  'Never-Converted Recent': 'never_converted_recent',
  'Never-Converted Old': 'never_converted_old',
  'Trash List': 'trash',
  'Cancelled Pendings': 'cancelled_pendings',
  'Due to Reorder': 'due_to_reorder',
  'FULL MONAD LIST': 'monad',
} as const;
export type PenKey = (typeof PREDICTION_PENS)[keyof typeof PREDICTION_PENS];

const BANDED_ORDERS = /^(\S+) (≤)?(\d+(?:\.\d+)?)(\+)? \((\d+(?:-\d+)?\+?) orders\)$/;
const NEWCOMERS = /^NEWCOMERS \((\d+(?:-\d+)?\+?) orders\)$/;

export function parsePredictionListName(name: string | null | undefined): ParsedListName {
  const s = String(name ?? '');
  const none: ParsedListName = { kind: 'other', recency: null, band: null, threshold: null, orders: null, pen: null };
  const pen = (PREDICTION_PENS as Record<string, PenKey>)[s];
  if (pen) return { ...none, kind: 'pen', pen };
  const n = NEWCOMERS.exec(s);
  if (n) return { ...none, kind: 'newcomers', recency: 'NEWCOMERS', orders: n[1] };
  const m = BANDED_ORDERS.exec(s);
  if (m && !!m[2] !== !!m[4]) {
    return { ...none, kind: 'band', recency: m[1], band: m[2] ? 'le' : 'gt', threshold: Number(m[3]), orders: m[5] };
  }
  return none;
}

export function predictionListLabel(name: string | null | undefined): string {
  const s = String(name ?? '');
  const m = BANDED.exec(s);
  if (!m) return s;
  const [, recency, le, num, plus, rest] = m;
  if (!!le === !!plus) return s;  // exactly one of "≤N" / "N+"
  const den = formatMoney(Number(num));  // "1.599 ден"
  const band = le ? `≤ ${den}` : den.replace(/ ден$/, '+ ден');
  return `${recency} ${band} ${rest}`;
}
