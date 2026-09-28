import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import i18n from '@/i18n';
import { NO_PARCEL_DEFAULT_DAYS, noParcelDaysOr } from './noParcelRule';

// The rule's window is read from app_settings (owner 28.09: 7 → 10); labels
// take it from the payload and fall back to 10 — the "7d" in the stored codes
// is an identifier only.
describe('no-parcel rule window in labels', () => {
  beforeAll(async () => { await i18n.changeLanguage('mk'); });
  afterAll(async () => { await i18n.changeLanguage('en'); });

  it('uses the payload days, else 10', () => {
    expect(NO_PARCEL_DEFAULT_DAYS).toBe(10);
    expect(noParcelDaysOr(12)).toBe(12);
    expect(noParcelDaysOr(undefined)).toBe(10);
    expect(noParcelDaysOr(null)).toBe(10);
    expect(noParcelDaysOr('x')).toBe(10);
    expect(noParcelDaysOr(0)).toBe(10);
  });

  it('no rule label hardcodes 7 any more, in any locale', () => {
    for (const lng of ['en', 'mk', 'bg', 'sq']) {
      const t = i18n.getFixedT(lng);
      expect(t('overview.attention.kind.approved_no_parcel_7d', { days: 12 })).toContain('12');
      expect(t('settings.integrations.feed.no_parcel_rule', { days: 12 })).toContain('12');
      expect(t('settings.integrations.np.hintApply', { days: 12 })).toContain('12');
      expect(t('cancelReason.no_parcel_7d')).not.toMatch(/\b7\b/);
    }
    expect(i18n.t('cancelReason.no_parcel_7d')).toBe('Нема MEX пратка во рок');
  });
});
