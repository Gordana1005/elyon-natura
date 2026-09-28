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
