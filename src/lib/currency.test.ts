import { describe, it, expect } from 'vitest';
import { MKD_PER_EUR, eurToDen, denToEur, denInputToEur, formatMoney, formatDenari, formatEurExact, formatPriceInline, codFor } from './currency';

// These tests exist to make two specific, expensive mistakes impossible to ship.
//
// 1. Someone "corrects" MKD_PER_EUR to today's market rate. That silently
//    re-prices every historical order, every closed agent payout and every COD
//    already collected. The pinned values below turn that into a failed build.
//
// 2. Someone changes the COD amount without the currency code, or vice versa.
//    A courier file saying MKD next to a euro-scale number means the courier
//    collects ~1/61st of the money, on every parcel, with nothing throwing.

describe('MKD peg', () => {
  it('is frozen at 61.5 — DO NOT "update to the current rate"', () => {
    // If this fails, someone edited the peg. That is almost never correct:
    // re-price the catalogue in EUR instead. See src/lib/currency.ts.
    expect(MKD_PER_EUR).toBe(61.5);
  });

  it('converts EUR to whole denars', () => {
    expect(eurToDen(30)).toBe(1845);
    expect(eurToDen(34.9)).toBe(2146);   // 2146.35 -> 2146
    expect(eurToDen(0)).toBe(0);
  });

  it('round-trips denars back to EUR', () => {
    expect(denToEur(1845)).toBe(30);
  });

  it('survives junk input instead of rendering NaN at a customer', () => {
    expect(eurToDen('' as unknown as number)).toBe(0);
    expect(eurToDen('abc' as unknown as number)).toBe(0);
    expect(eurToDen(null as unknown as number)).toBe(0);
    expect(formatMoney(undefined as unknown as number)).toBe('0 ден');
  });
});

describe('formatting', () => {
  it('renders denars with Macedonian thousands grouping and no decimals', () => {
    expect(formatMoney(30)).toBe('1.845 ден');
    expect(formatMoney(200)).toBe('12.300 ден');
    expect(formatMoney(5)).toBe('308 ден');       // 307.5 -> 308
  });

  it('never emits a lev or euro symbol from the primary formatter', () => {
    const out = [0, 1, 30, 1234].map(formatMoney).join(' ');
    expect(out).not.toMatch(/лв|BGN|€/);
  });

  it('keeps a deliberate EUR formatter for affiliate/partner amounts', () => {
    expect(formatEurExact(7.5)).toBe('€7.50');
  });

  it('formatPriceInline is denar-only (no dual display)', () => {
    expect(formatPriceInline(30)).toBe('1.845 ден');
  });

  it('handles negatives (reversed commissions on returns)', () => {
    expect(formatMoney(-30)).toBe('-1.845 ден');
  });

  it('formatDenari prints an amount that is already denars — no second conversion', () => {
    // MEX COD arrives in denars. Running it through formatMoney would print
    // 61.5× the cash — the webhook 61× bug.
    expect(formatDenari(4000)).toBe('4.000 ден');
    expect(formatDenari(1979400)).toBe('1.979.400 ден');
    expect(formatDenari(2489.6)).toBe('2.490 ден');
    expect(formatDenari(null)).toBe('0 ден');
    expect(formatDenari('abc')).toBe('0 ден');
    expect(formatDenari(-150)).toBe('-150 ден');
  });
});

describe('denInputToEur — a денари input over a stored-EUR value', () => {
  it('an untouched field saves the stored EUR exactly (no 1-cent drift)', () => {
    expect(denInputToEur(String(eurToDen(34.9)), 34.9)).toBe(34.9);   // 2146 ден, not 34.89 €
    expect(denInputToEur(String(eurToDen(48.78)), '48.78')).toBe(48.78);
    expect(denInputToEur('30750', 500)).toBe(500);
  });

  it('a typed figure converts at the frozen peg, 2 dp', () => {
    expect(denInputToEur('3000', 34.9)).toBe(48.78);
    expect(denInputToEur('3000')).toBe(48.78);
    expect(eurToDen(denInputToEur('3000')!)).toBe(3000);                // renders back unchanged
    expect(denInputToEur('1600', null)).toBe(26.02);
  });

  it('empty or garbage → null', () => {
    expect(denInputToEur('')).toBeNull();
    expect(denInputToEur('  ')).toBeNull();
    expect(denInputToEur('abc', 10)).toBeNull();
  });
});

describe('COD — the amount a courier physically collects', () => {
  it('returns amount and currency together, always', () => {
    expect(codFor(30)).toEqual({ amount: 1850, currency: 'MKD' });
  });

  it('rounds to the nearest 10 denars (cash handling)', () => {
    expect(codFor(34.9).amount).toBe(2150);   // 2146.35 -> 2146 -> 2150
    expect(codFor(45).amount).toBe(2770);     // 2767.5  -> 2768 -> 2770
  });

  it('is never a euro-scale number — the classic half-migration bug', () => {
    // A €45 order must ship a label reading ~2770, not 45 and not 88 (the lev
    // figure). Anything under 1000 here means the conversion was dropped.
    expect(codFor(45).amount).toBeGreaterThan(1000);
  });

  it('never reports a currency the amount was not computed in', () => {
    for (const eur of [0, 1, 14, 30, 34.9, 45, 199]) {
      const { amount, currency } = codFor(eur);
      expect(currency).toBe('MKD');
      expect(amount).toBe(Math.round(Math.round(eur * MKD_PER_EUR) / 10) * 10);
    }
  });
});
