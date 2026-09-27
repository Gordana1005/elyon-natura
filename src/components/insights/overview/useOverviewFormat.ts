import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDenari, formatMoney } from '@/lib/currency';
import { agoParts, compactParts, fmtInt, fmtPct, shareText } from './model';

/** dd.MM (or dd.MM.yyyy) straight off a YYYY-MM-DD — no timezone can shift it. */
export const dm = (ymd: string, withYear = false) =>
  ymd && ymd.length >= 10 ? `${ymd.slice(8, 10)}.${ymd.slice(5, 7)}${withYear ? `.${ymd.slice(0, 4)}` : ''}` : ymd;

/**
 * Formatting bound to the reader's language. Money: EUR → formatMoney, denars →
 * formatDenari (never the other way round). Counts and percentages follow the
 * UI language; money keeps the fixed Macedonian grouping everywhere, as in the
 * rest of the app.
 */
export function useOverviewFormat() {
  const { t, i18n } = useTranslation();
  const lang = i18n.language;
  return useMemo(() => {
    const compact = (v: number) => {
      const { n, unit } = compactParts(v);
      const shown = lang === 'en' ? n : n.replace('.', ',');
      return unit === 'k' ? t('overview.unit.k', { n: shown }) : unit === 'm' ? t('overview.unit.m', { n: shown }) : shown;
    };
    const ago = (iso: string | null | undefined, now: number) => {
      const p = agoParts(iso, now);
      if (!p) return t('overview.ago.never');
      if (p.unit === 'now') return t('overview.ago.now');
      return t(`overview.ago.${p.unit}`, { n: p.n });
    };
    const minutes = (min: number | null | undefined) => {
      const total = Math.max(0, Math.round(Number(min) || 0));
      const h = Math.floor(total / 60), m = total % 60;
      return h > 0 ? t('presence.hm', { h, m }) : t('presence.m', { m });
    };
    const period = (from: string, to: string) => (from === to ? dm(from, true) : `${dm(from)} – ${dm(to, true)}`);
    const bucketLabel = (b: string) => t(`overview.bucket.${b}`);
    // `teleshop_other` would read as an i18next plural form, so its key is camelCase.
    const source = (k: string) => t(`overview.source.${k === 'teleshop_other' ? 'teleshopOther' : k}`, { defaultValue: k });
    return {
      t, lang,
      eur: (v: number | null | undefined) => formatMoney(Number(v) || 0),
      den: (v: number | null | undefined) => formatDenari(v),
      int: (v: number | null | undefined) => fmtInt(v, lang),
      pct: (v: number | null | undefined, digits = 1) => fmtPct(v, lang, digits),
      share: (n: number, of: number) => shareText(n, of, lang),
      compact, ago, minutes, period, bucketLabel, source,
    };
  }, [t, lang]);
}

export type OverviewFormat = ReturnType<typeof useOverviewFormat>;
