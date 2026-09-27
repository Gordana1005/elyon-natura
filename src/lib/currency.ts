// ── Money, Macedonia ────────────────────────────────────────────────────────
//
// STORAGE IS EUR. Every price, payout and commission in the database is a EUR
// number, exactly as upstream. This module is the single place that turns those
// into the denar figures the customer, the agent and the courier actually see.
//
// ⚠️ MKD_PER_EUR IS FROZEN. Do not "update it to today's rate", ever.
//
// Bulgaria's lev is legally fixed to the euro forever, so deriving it at render
// time is safe. The denar is NOT: it is a managed peg maintained by the NBRM.
// The moment someone edits this constant, every historical order, every closed
// agent payout, every past revenue report and every COD amount already collected
// from a customer silently re-prices itself. There is no audit trail for that
// and no way to tell which figure was the one actually quoted on the phone.
//
// If the market rate genuinely moves, re-price the CATALOGUE in EUR instead —
// that changes future orders only and leaves history intact.
export const MKD_PER_EUR = 61.5;

/** EUR → whole denars. Denars have no practical subunit, so this always rounds. */
export function eurToDen(eur: number | string): number {
  const n = Number(eur);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * MKD_PER_EUR);
}

/** Denars → EUR, for the few admin inputs that accept a denar figure. */
export function denToEur(den: number | string): number {
  const n = Number(den);
  if (!Number.isFinite(n)) return 0;
  return Math.round((n / MKD_PER_EUR) * 100) / 100;
}

// Macedonian grouping uses "." for thousands. Done manually rather than via
// toLocaleString('mk-MK') so the output is identical in every browser and in
// Node during tests — locale data for mk-MK is not universally present.
function groupMk(n: number): string {
  const neg = n < 0;
  const s = Math.abs(Math.round(n)).toString();
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += '.';
    out += s[i];
  }
  return (neg ? '-' : '') + out;
}

/**
 * THE money formatter. Takes a stored EUR value, renders denars.
 * Use this for anything a customer, agent or manager reads.
 *
 * Named `formatMoney` rather than `formatEur` on purpose: a function with "Eur"
 * in its name that prints denars is how you end up with a hardcoded "€" typed
 * in next to it six months later.
 */
export const formatMoney = (eur: number | string) => `${groupMk(eurToDen(eur))} ден`;

/**
 * For amounts that are ALREADY denars — MEX cash-on-delivery (`mex_cod_mkd`,
 * `cod_mkd`, `delivered_cash_mkd`). Never pass a EUR price here (that is
 * `formatMoney`), and never pass a denar amount to `formatMoney` (that would
 * multiply it by the peg a second time — the 61× bug).
 */
export const formatDenari = (mkd: number | string | null | undefined) => {
  const n = Number(mkd);
  return `${groupMk(Number.isFinite(n) ? n : 0)} ден`;
};

/**
 * Deliberate EUR display — only for surfaces where EUR really is the unit:
 * affiliate offers (partner networks are priced in EUR) and the internal
 * margin bands. Always label these as EUR in the UI.
 */
export const formatEurExact = (eur: number | string) =>
  `€${(Number(eur) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Single-line price. In Macedonia that is just the denar figure. */
export const formatPriceInline = (eur: number | string) => formatMoney(eur);

/**
 * Cash-on-delivery amount handed to the courier.
 *
 * Rounded to the nearest 10 denars: it is physical cash, and it makes the
 * figure sayable on the phone. Rounded ONCE, on the order total — never per
 * line and summed, or the lines stop reconciling with the total the customer
 * actually agreed to.
 *
 * Returns the currency alongside the amount so the two can never be exported
 * independently. A CSV that says MKD next to a lev-converted number makes the
 * courier collect ~3% of the money, silently, on every parcel.
 */
export function codFor(eurPrice: number | string): { amount: number; currency: 'MKD' } {
  return { amount: Math.round(eurToDen(eurPrice) / 10) * 10, currency: 'MKD' };
}
