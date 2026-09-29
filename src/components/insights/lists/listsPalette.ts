/**
 * Colour for Insights → Prediction lists. Nothing new is invented here: every
 * value is a slot the dataviz validator already passed for THIS app's card
 * surfaces (light #ffffff, dark #171b26).
 *
 * - The parts of a sale (trend stacks, ranking bars): the cohort palette
 *   (../shared/cohortPalette.ts) — paid · unproven · courier · label · to pack
 *   · returned, the bar's own order; "paid by ruling" folds into paid and the
 *   courier's problem part into courier, so the adjacent pairs are a subset of
 *   the pairs validated there (all pairs checked, both modes).
 * - Magnitude with no parts (the recency × value matrix bars): ONE hue, the
 *   Affiliate – Lead out source colour of the Overview (overview/palette.ts,
 *   --ov-src-elyon_crm #eb6834 / #d95926 — the lists are that department's) —
 *   length carries the value, the number is printed beside it, so no
 *   sequential colour ramp (and no text-on-fill contrast problem) is needed.
 * - Decisions (the work card): sale = paid emerald, "no" = the red of
 *   Откажани, trash = the grey of Во корпа — the LeadsInCard trio.
 *
 * recharts needs colours, not classes: the same hexes as CSS custom
 * properties, set once on the tab root (light + .dark).
 */
import type { TrendPart } from './listModel';

export const LISTS_COLOR_VARS =
  '[--ls-paid:#059669] [--ls-paid_unproven:#dc2626] [--ls-courier:#312e81] [--ls-label:#4f46e5] [--ls-to_pack:#818cf8] [--ls-returned:#f472b6] ' +
  'dark:[--ls-paid:#10b981] dark:[--ls-paid_unproven:#dc2626] dark:[--ls-courier:#c7d2fe] dark:[--ls-label:#818cf8] dark:[--ls-to_pack:#4f46e5] dark:[--ls-returned:#db2777]';

export const trendColorVar = (k: TrendPart) => `var(--ls-${k})`;

/** The matrix bars: Affiliate – Lead out's source hue (literal classes so Tailwind emits them). */
export const MAGNITUDE_BAR = 'bg-[#eb6834] dark:bg-[#d95926]';
