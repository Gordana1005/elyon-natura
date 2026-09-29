/**
 * Colour roles of Insights → Продажби that the shared palettes do not cover.
 * Everything else is reused as validated: the six departments are the Overview's
 * fixed identity hues (overview/palette.ts, --ov-src-*), the cohort parts the
 * shared cohort ramp (shared/cohortPalette.ts).
 *
 * HEAT — weekday × hour, a SEQUENTIAL one-hue ramp (blue), 5 steps, step 1 =
 * the quietest non-empty hour, step 5 = the busiest; an empty hour is the
 * muted surface. Run through the dataviz skill's validator
 * (scripts/validate_palette.js --ordinal) against THIS app's card surfaces:
 *   light #86b6ef #5598e7 #2a78d6 #1c5cab #0d366b on #ffffff — PASS
 *         (monotone L, ΔL ≥ .06, hue spread 4°, light end 2.11:1)
 *   dark  #184f95 #256abf #3987e5 #6da7ec #b7d3f6 on #171b26 — PASS
 *         (dark flips the anchor: busier = lighter; dark end 2.12:1)
 * The grid prints the count in every cell and has a table twin, so the hue
 * never carries a number alone; a legend names the scale.
 *
 * NEUTRAL — a single-series bar that is not a source (packages per sale):
 * slate, so it never reads as one of the six source hues.
 */

/** Literal class strings (Tailwind generates them). Index 0 = no sale. */
export const HEAT_TONE = [
  'bg-muted',
  'bg-[#86b6ef] dark:bg-[#184f95]',
  'bg-[#5598e7] dark:bg-[#256abf]',
  'bg-[#2a78d6] dark:bg-[#3987e5]',
  'bg-[#1c5cab] dark:bg-[#6da7ec]',
  'bg-[#0d366b] dark:bg-[#b7d3f6]',
] as const;

/** Ink on a heat cell: dark on the light steps, white on the deep ones. */
export const HEAT_INK = [
  'text-muted-foreground',
  'text-slate-900 dark:text-white',
  'text-slate-900 dark:text-white',
  'text-white dark:text-slate-900',
  'text-white dark:text-slate-900',
  'text-white dark:text-slate-900',
] as const;

export const NEUTRAL_BAR = 'bg-[#64748b] dark:bg-[#94a3b8]';

/** New vs returning buyers — an ordinal slate pair (a part-to-whole of ONE
 *  measure, not a category: never a source hue, never a cohort part's colour).
 *  Words and numbers sit beside the bar; colour never carries it alone. */
export const BUYER_NEW = 'bg-[#94a3b8] dark:bg-[#64748b]';
export const BUYER_RETURNING = 'bg-[#334155] dark:bg-[#cbd5e1]';
