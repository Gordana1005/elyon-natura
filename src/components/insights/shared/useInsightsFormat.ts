import { useMemo } from 'react';
import { useOverviewFormat } from '../overview/useOverviewFormat';
import type { CohortBucketKey, CohortOutsideKey, CohortQualityKind } from './cohortTypes';

/** Which day a widget counts by — the small caption every widget carries. */
export const CLOCKS = ['sale', 'created', 'decided', 'delivered', 'mex_created', 'returned', 'call', 'now'] as const;
export type ClockKey = (typeof CLOCKS)[number];

/** Server sentinels: labels come from the reader's language, never from the api. */
export const SENTINEL_UNKNOWN = '__unknown__';
export const SENTINEL_OTHERS = '__others__';

/**
 * The Overview's formatting (numbers with the reader's marks, денари via
 * formatDenari, EUR via formatMoney, shares that never lie by rounding) plus
 * the shared /insights vocabulary under insights.common.*.
 */
export function useInsightsFormat() {
  const f = useOverviewFormat();
  const { t } = f;
  return useMemo(() => ({
    ...f,
    // `teleshop_other` would read as an i18next plural form, so its key is camelCase.
    sourceLabel: (k: string) =>
      t(`insights.common.source.${k === 'teleshop_other' ? 'teleshopOther' : k}`, { defaultValue: k }),
    bucketLabel: (k: CohortBucketKey | string) => t(`insights.common.bucket.${k}`, { defaultValue: k }),
    outsideLabel: (k: CohortOutsideKey | string) => t(`insights.common.outside.${k}`, { defaultValue: k }),
    qualityLabel: (k: CohortQualityKind | string) => t(`insights.common.quality.kind.${k}`, { defaultValue: k }),
    clockLabel: (k: ClockKey) => t(`insights.common.clock.${k}`),
    /** A sub-channel (by_source[].splits key); unknown keys show as sent.
     *  A key ending in `_other` is looked up camelCased (mex_other → mexOther):
     *  i18next would read `…_other` as a plural form. */
    splitLabel: (k: string) =>
      t(`insights.common.split.${k.replace(/_other$/, 'Other')}`, { defaultValue: k }),
    /** A dimension value from the api: sentinels in the reader's language, the rest as sent. */
    dimLabel: (v: string | null | undefined) =>
      v == null || v === '' || v === SENTINEL_UNKNOWN ? t('insights.common.sentinel.unknown')
        : v === SENTINEL_OTHERS ? t('insights.common.sentinel.others') : v,
  }), [f, t]);
}

export type InsightsFormat = ReturnType<typeof useInsightsFormat>;
